/**
 * v3-engine.test.ts
 *
 * 下一代 workflow（v3）引擎纯逻辑测试：dag 校验/拓扑、orchestrator 决策、
 * journal append/replay、state 物化与 checkpoint 读写。全部纯逻辑 + 临时目录
 * IO，不 spawn worker、不碰飞书、不依赖 codex 的 ephemeral-pool/manifest。
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateDag,
  loadDag,
  topologicalOrder,
  isGoalNode,
  DagValidationError,
  type V3Dag,
} from '../src/workflows/v3/dag.js';
import { decideNext, findSinks, type V3RunState } from '../src/workflows/v3/orchestrator.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { materialize, writeState, readState } from '../src/workflows/v3/state.js';

// ── 测试夹具 ──────────────────────────────────────────────────────────────

/** research → summarize 的两节点 DAG（设计稿 §4 的最小闭环）。 */
const TWO_NODE: unknown = {
  runId: 'demo-001',
  nodes: [
    { id: 'research', type: 'goal', goal: '调研 X', depends: [], inputs: [] },
    { id: 'summarize', type: 'goal', goal: '写摘要', depends: ['research'], inputs: [{ from: 'research' }] },
  ],
};

// ── dag 校验 ────────────────────────────────────────────────────────────────

describe('validateDag', () => {
  it('接受合法 DAG 并填默认值', () => {
    const dag = validateDag(TWO_NODE);
    expect(dag.runId).toBe('demo-001');
    expect(dag.nodes).toHaveLength(2);
    expect(dag.nodes[0]!.humanGate).toBeNull(); // 未给 → 归一为 null
    expect(isGoalNode(dag.nodes[0]!)).toBe(true);
  });

  it('一次性吐出全部问题', () => {
    let err: DagValidationError | undefined;
    try {
      validateDag({ runId: 'bad id!', nodes: [{ id: 'a', type: 'goal', goal: '', depends: [], inputs: [] }] });
    } catch (e) {
      err = e as DagValidationError;
    }
    expect(err).toBeInstanceOf(DagValidationError);
    // runId 非法 + goal 为空，两个问题都在
    expect(err!.problems.length).toBeGreaterThanOrEqual(2);
  });

  it('拒绝 type:host（MVP 未实现执行器）', () => {
    expect(() => validateDag({ runId: 'r', nodes: [{ id: 'a', type: 'host', depends: [], inputs: [] }] }))
      .toThrow(/host/);
  });

  it('拒绝 depends 指向不存在的节点', () => {
    expect(() => validateDag({ runId: 'r', nodes: [{ id: 'a', type: 'goal', goal: 'g', depends: ['ghost'], inputs: [] }] }))
      .toThrow(/unknown node "ghost"/);
  });

  it('拒绝 inputs.from 不在 depends 里', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: [], inputs: [{ from: 'a' }] },
      ],
    })).toThrow(/must also be in depends/);
  });

  it('拒绝重复节点 id', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
      ],
    })).toThrow(/duplicate node id "a"/);
  });

  it('拒绝环', () => {
    expect(() => validateDag({
      runId: 'r',
      nodes: [
        { id: 'a', type: 'goal', goal: 'g', depends: ['b'], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: ['a'], inputs: [] },
      ],
    })).toThrow(/cycle/);
  });
});

describe('topologicalOrder', () => {
  it('依赖在前，且同层按 id 确定性排序', () => {
    const dag = validateDag({
      runId: 'r',
      nodes: [
        { id: 'c', type: 'goal', goal: 'g', depends: ['a', 'b'], inputs: [] },
        { id: 'b', type: 'goal', goal: 'g', depends: [], inputs: [] },
        { id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [] },
      ],
    });
    // a、b 无依赖 → 按 id 升序在前；c 依赖二者 → 最后
    expect(topologicalOrder(dag)).toEqual(['a', 'b', 'c']);
  });
});

// ── orchestrator 决策 ────────────────────────────────────────────────────────

describe('decideNext', () => {
  const dag: V3Dag = validateDag(TWO_NODE);

  it('空状态：只派根节点，依赖未就绪的不派', () => {
    const actions = decideNext(dag, new Map());
    expect(actions).toEqual([{ kind: 'dispatchWork', nodeId: 'research' }]);
  });

  it('根节点 done 后派下游', () => {
    const state: V3RunState = new Map([['research', { status: 'done' }]]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'dispatchWork', nodeId: 'summarize' }]);
  });

  it('运行中节点不重复派', () => {
    const state: V3RunState = new Map([['research', { status: 'running' }]]);
    expect(decideNext(dag, state)).toEqual([]);
  });

  it('全部 done → 整 run 成功', () => {
    const state: V3RunState = new Map([
      ['research', { status: 'done' }],
      ['summarize', { status: 'done' }],
    ]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'completeRunSucceeded' }]);
  });

  it('fail-fast：任一节点失败 → 整 run 失败', () => {
    const state: V3RunState = new Map([['research', { status: 'failed' }]]);
    expect(decideNext(dag, state)).toEqual([{ kind: 'completeRunFailed', failedNodeId: 'research' }]);
  });

  it('humanGate：先派 gate，approved 后派 work', () => {
    const gated = validateDag({
      runId: 'g',
      nodes: [{ id: 'a', type: 'goal', goal: 'g', depends: [], inputs: [], humanGate: { prompt: '批？' } }],
    });
    expect(decideNext(gated, new Map())).toEqual([{ kind: 'dispatchGate', nodeId: 'a' }]);
    // gate 已批准（gateCleared）→ 派 work
    const cleared: V3RunState = new Map([['a', { status: 'pending', gateCleared: true }]]);
    expect(decideNext(gated, cleared)).toEqual([{ kind: 'dispatchWork', nodeId: 'a' }]);
  });

  it('findSinks 找到末端节点', () => {
    expect(findSinks(dag)).toEqual(['summarize']);
  });
});

// ── journal + state 物化 ────────────────────────────────────────────────────

describe('journal + state', () => {
  it('append → read → materialize 还原出正确快照', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-journal-'));
    try {
      const jp = join(dir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'demo-001' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' });
      appendEvent(jp, { type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: '/x/manifest.json' });
      appendEvent(jp, { type: 'nodeDispatched', nodeId: 'summarize', attemptId: 'summarize/attempts/001' });

      const events = readJournal(jp);
      expect(events).toHaveLength(4);
      expect(typeof events[0]!.ts).toBe('number');

      const snap = materialize(events);
      expect(snap.runStatus).toBe('running');
      expect(snap.nodes.get('research')!.status).toBe('done');
      expect(snap.nodes.get('summarize')!.status).toBe('running');
      expect(snap.attempts.get('summarize')).toBe('summarize/attempts/001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gate 批准 → pending+gateCleared；拒绝 → failed', () => {
    const approved = materialize([
      { ts: 1, type: 'gateDispatched', nodeId: 'a', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'approved', by: 'u' },
    ]);
    expect(approved.nodes.get('a')).toEqual({ status: 'pending', gateCleared: true });

    const rejected = materialize([
      { ts: 1, type: 'gateDispatched', nodeId: 'a', waitId: 'w1' },
      { ts: 2, type: 'gateResolved', nodeId: 'a', waitId: 'w1', resolution: 'rejected', by: 'u' },
    ]);
    expect(rejected.nodes.get('a')!.status).toBe('failed');
  });

  it('runFailed 记录 failedNodeId', () => {
    const snap = materialize([
      { ts: 1, type: 'nodeFailed', nodeId: 'research', attemptId: 'research/attempts/001', errorClass: 'workerError' },
      { ts: 2, type: 'runFailed', failedNodeId: 'research' },
    ]);
    expect(snap.runStatus).toBe('failed');
    expect(snap.failedNodeId).toBe('research');
  });

  it('STATE checkpoint 原子写 + 读回一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-state-'));
    try {
      const sp = join(dir, 'STATE');
      const snap = materialize([
        { ts: 1, type: 'nodeDispatched', nodeId: 'research', attemptId: 'research/attempts/001' },
        { ts: 2, type: 'nodeSucceeded', nodeId: 'research', attemptId: 'research/attempts/001', manifestPath: '/x' },
      ]);
      writeState(sp, snap);
      const back = readState(sp)!;
      expect(back.runStatus).toBe('running');
      expect(back.nodes.get('research')!.status).toBe('done');
      expect(back.attempts.get('research')).toBe('research/attempts/001');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readJournal 容忍末行截断（崩溃半写）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-torn-'));
    try {
      const jp = join(dir, 'journal.ndjson');
      appendEvent(jp, { type: 'runStarted', runId: 'r' });
      // 模拟半写的最后一行
      appendFileSync(jp, '{"ts":2,"type":"nodeDispa');
      const events = readJournal(jp);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('runStarted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── loadDag（文件 IO）─────────────────────────────────────────────────────────

describe('loadDag', () => {
  it('读不存在的文件给出清晰错误', () => {
    expect(() => loadDag('/nonexistent/dag.json')).toThrow(/cannot read dag.json/);
  });
});
