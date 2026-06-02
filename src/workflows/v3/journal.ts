/**
 * v3 journal — append-only event stream (the run's audit truth).
 *
 * Codex's v1-review blocker #1: v3 is NOT a "only-mutable-STATE" recoverable
 * system.  `journal.ndjson` is the append-only source of audit truth (one JSON
 * object per line, `ts`-stamped) from which `state.ts` materializes the STATE
 * checkpoint.  Concurrency / retry / gate / cancel / failure-root-cause all
 * leave an ordered trail here.
 *
 * Append-only + line-oriented = crash-tolerant by construction: a torn final
 * line (process died mid-write) is skipped on read; everything before it is
 * intact.  No locking needed for the journal itself — appends are serialized
 * by the single runtime loop (the per-node LOCK guards worker dispatch, not
 * the journal).
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ─── Event taxonomy ─────────────────────────────────────────────────────────

/** Why a node failed — drives fail-fast root-cause reporting + (later) retry
 *  policy.  `gateRejected` / `cancelled` are user-driven; the rest are faults. */
export type V3ErrorClass =
  | 'workerError'      // ephemeral worker crashed / non-zero exit
  | 'manifestInvalid'  // worker exited ok but manifest failed validation
  | 'timeout'          // node exceeded its wall-clock budget
  | 'gateRejected'     // human rejected the approval gate
  | 'cancelled';       // run cancelled out from under the node

/**
 * The MVP event union.  Static DAG + fail-fast, so the lifecycle is small:
 * run boundaries, per-node dispatch/settle, and gate dispatch/resolve.  Retry
 * (`attempts/NNN`) is modeled by `attemptId` on dispatch/settle events — a new
 * attempt is just another `nodeDispatched` with a fresh `attemptId`.
 */
export type V3Event =
  | { type: 'runStarted'; runId: string }
  | { type: 'nodeDispatched'; nodeId: string; attemptId: string }
  | { type: 'nodeSucceeded'; nodeId: string; attemptId: string; manifestPath: string }
  | { type: 'nodeFailed'; nodeId: string; attemptId: string; errorClass: V3ErrorClass; message?: string }
  | { type: 'gateDispatched'; nodeId: string; waitId: string }
  | { type: 'gateResolved'; nodeId: string; waitId: string; resolution: 'approved' | 'rejected'; by: string }
  | { type: 'runSucceeded' }
  | { type: 'runFailed'; failedNodeId: string };

/** A journal line: the event flattened with its append timestamp (flattened —
 *  not `{ts, event}` — so `grep nodeFailed journal.ndjson` just works). */
export type StoredEvent = V3Event & { ts: number };

// ─── Append ─────────────────────────────────────────────────────────────────

/**
 * Append one event as a single NDJSON line.  Stamps `ts` (epoch ms) at write
 * time.  Creates the parent directory if missing so the very first
 * `runStarted` doesn't require the caller to pre-create the runDir.
 *
 * Synchronous on purpose: the runtime loop must observe its own writes in
 * order, and the journal is the linearization point — an async append would
 * open a window where `decideNext` runs against stale state.
 */
export function appendEvent(journalPath: string, event: V3Event): StoredEvent {
  const stored: StoredEvent = { ts: Date.now(), ...event };
  const dir = dirname(journalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(journalPath, JSON.stringify(stored) + '\n');
  return stored;
}

// ─── Read / replay ────────────────────────────────────────────────────────

/**
 * Read every event in append order.  Tolerates a torn final line (crash
 * mid-append) by skipping any line that fails to parse — the journal stays
 * usable for replay after an unclean shutdown.  Returns `[]` if the file does
 * not exist yet (a run that never started).
 */
export function readJournal(journalPath: string): StoredEvent[] {
  if (!existsSync(journalPath)) return [];
  const raw = readFileSync(journalPath, 'utf-8');
  const out: StoredEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as StoredEvent);
    } catch {
      // Torn / partial final line from an interrupted append — skip it.
      // (Only the last line can legitimately be partial; a mid-file parse
      //  failure would indicate real corruption, but skipping is still the
      //  safe choice — replay proceeds with the events it can read.)
    }
  }
  return out;
}
