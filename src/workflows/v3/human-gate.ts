/**
 * v3 humanGate — file-backed approval waits.
 *
 * Codex's v1-review blocker #4: a workflow gate is RUNTIME state, not an
 * in-memory chat ask.  Its pending/resolved status MUST persist to the runDir
 * so a daemon restart doesn't lose a pending approval.  The journal already
 * records `gateDispatched` / `gateResolved` (audit truth); this module owns the
 * materialized, mutable wait files under `runDir/waits/<waitId>.json` — the
 * active state the Lark card layer keys off and the restart-recovery scan reads.
 *
 * Split of concerns:
 *   - THIS file: the file-wait store + a gate resolver that persists
 *     pending → resolved around an injected decision source.  Pure file IO,
 *     bot-agnostic, testable without the daemon.
 *   - daemon (later): supplies `awaitDecision` — posts the Lark approval card
 *     (reusing v0.2's card-builder / card-handler UX) and resolves when the
 *     button is clicked; on restart it re-arms pending waits via
 *     `listPendingWaits`.
 *
 * The wait shape mirrors v0.2's `waitKind: 'human-gate'` lineage but is
 * deliberately minimal for the MVP (no deadline / allow-list yet).
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { V3RuntimeDeps } from './runtime.js';

export type GateWaitStatus = 'pending' | 'approved' | 'rejected';

export interface GateWait {
  waitId: string;
  nodeId: string;
  prompt: string;
  status: GateWaitStatus;
  createdAt: number;
  resolvedAt?: number;
  /** open_id (or 'system') of the resolver, once resolved. */
  by?: string;
}

/** The concrete (non-optional) shape the runtime injects as `resolveGate`. */
export type GateResolver = NonNullable<V3RuntimeDeps['resolveGate']>;

// ─── File-wait store ────────────────────────────────────────────────────────

export function waitsDir(runDir: string): string {
  return join(runDir, 'waits');
}

export function waitPath(runDir: string, waitId: string): string {
  return join(waitsDir(runDir), `${waitId}.json`);
}

/** Atomic JSON write (tmp + rename) so a crash never leaves a torn wait file. */
function atomicWriteJson(path: string, value: unknown): void {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** Write the initial `pending` wait file for a gate.  Overwrites any stale
 *  file at the same waitId (a re-dispatched gate). */
export function writePendingWait(
  runDir: string,
  input: { waitId: string; nodeId: string; prompt: string },
): GateWait {
  const wait: GateWait = {
    waitId: input.waitId,
    nodeId: input.nodeId,
    prompt: input.prompt,
    status: 'pending',
    createdAt: Date.now(),
  };
  atomicWriteJson(waitPath(runDir, input.waitId), wait);
  return wait;
}

/** Read a single wait file, or `undefined` if it doesn't exist. */
export function readWait(runDir: string, waitId: string): GateWait | undefined {
  const path = waitPath(runDir, waitId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf-8')) as GateWait;
}

/** Transition a wait to approved / rejected.  Throws if the wait is missing
 *  (a resolution for an unknown gate is a programming error, not a no-op). */
export function resolveWait(
  runDir: string,
  waitId: string,
  resolution: 'approved' | 'rejected',
  by: string,
): GateWait {
  const existing = readWait(runDir, waitId);
  if (!existing) throw new Error(`v3 human-gate: no pending wait "${waitId}" in ${runDir}`);
  const resolved: GateWait = { ...existing, status: resolution, resolvedAt: Date.now(), by };
  atomicWriteJson(waitPath(runDir, waitId), resolved);
  return resolved;
}

/** All still-pending waits in the runDir — the daemon's restart-recovery scan
 *  uses this to re-post / re-arm approval cards after a crash. */
export function listPendingWaits(runDir: string): GateWait[] {
  const dir = waitsDir(runDir);
  if (!existsSync(dir)) return [];
  const out: GateWait[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    try {
      const wait = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as GateWait;
      if (wait.status === 'pending') out.push(wait);
    } catch {
      // skip a torn / unparseable wait file (mid-write crash)
    }
  }
  return out;
}

// ─── Gate resolver (injected into the runtime) ──────────────────────────────

/**
 * Build the `resolveGate` the runtime injects.  Persists the wait as `pending`,
 * delegates to the daemon-supplied `awaitDecision` (post card + await the
 * click), then persists the resolution — so the file store is authoritative
 * for pending/resolved regardless of whether the in-memory decision promise
 * survives a restart (the daemon re-arms via `listPendingWaits`).
 *
 * `awaitDecision` is the only daemon-coupled seam; everything else here is file
 * IO, which is why this factory is unit-testable with a fake decision source.
 */
export function createFileGate(deps: {
  awaitDecision: (wait: GateWait) => Promise<{ resolution: 'approved' | 'rejected'; by: string }>;
}): GateResolver {
  return async ({ nodeId, prompt, waitId, runDir }) => {
    const wait = writePendingWait(runDir, { waitId, nodeId, prompt });
    const { resolution, by } = await deps.awaitDecision(wait);
    resolveWait(runDir, waitId, resolution, by);
    return resolution;
  };
}
