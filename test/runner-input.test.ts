import { describe, it, expect } from 'vitest';
import {
  writeRunnerInput,
  chunkAscii,
  encodeRunnerInput,
  RUNNER_INPUT_CHUNK_BYTES,
} from '../src/adapters/cli/runner-input.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

/** Fake tmux-mode PtyHandle that records sendText/sendSpecialKeys calls.
 *  `failTextAt` / `failEnter` make a specific write report a dropped keystroke
 *  (mirrors TmuxPipeBackend returning false on a pane-alive send-keys failure). */
function fakeTmuxPty(opts: { failTextAt?: number; failEnter?: boolean } = {}) {
  const textChunks: string[] = [];
  const enters: string[][] = [];
  let textCalls = 0;
  const pty: PtyHandle = {
    write() {
      throw new Error('tmux-mode pty should not use write()');
    },
    sendText(text: string) {
      const idx = textCalls++;
      if (opts.failTextAt === idx) return false;
      textChunks.push(text);
      return true;
    },
    sendSpecialKeys(...keys: string[]) {
      if (opts.failEnter) return false;
      enters.push(keys);
      return true;
    },
  };
  return { pty, textChunks, enters };
}

/** Fake raw-PTY handle (no tmux send methods): exercises the write() fallback. */
function fakeRawPty(opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = [];
  const pty: PtyHandle = {
    write(data: string) {
      if (opts.throwOnWrite) throw new Error('pty gone');
      writes.push(data);
    },
  };
  return { pty, writes };
}

const MARKER = '::botmux-codex-app:';

describe('chunkAscii', () => {
  it('splits into <=maxBytes pieces and rejoins losslessly', () => {
    const s = 'x'.repeat(2500);
    const chunks = chunkAscii(s, 1024);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(1024);
    expect(chunks[1].length).toBe(1024);
    expect(chunks[2].length).toBe(452);
    expect(chunks.join('')).toBe(s);
  });

  it('returns a single chunk when under the limit', () => {
    expect(chunkAscii('abc', 1024)).toEqual(['abc']);
  });
});

describe('writeRunnerInput — tmux mode', () => {
  it('chunks a large (>4KB) payload, every chunk within the byte cap, then one Enter', async () => {
    const big = 'A'.repeat(15_000); // base64 inflates this well past the N_TTY buffer
    const { pty, textChunks, enters } = fakeTmuxPty();

    const res = await writeRunnerInput(pty, MARKER, big);

    expect(res).toEqual({ submitted: true });
    expect(textChunks.length).toBeGreaterThan(1);
    for (const c of textChunks) expect(c.length).toBeLessThanOrEqual(RUNNER_INPUT_CHUNK_BYTES);
    // Exactly one trailing submit.
    expect(enters).toEqual([['Enter']]);
  });

  it('reassembled chunks decode back to the original content (no corruption, no stray newline)', async () => {
    const original = 'multi\nline\tmessage with 💥 unicode ' + 'z'.repeat(5000);
    const { pty, textChunks } = fakeTmuxPty();

    await writeRunnerInput(pty, MARKER, original);

    const line = textChunks.join('');
    expect(line.startsWith(MARKER)).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('\r');
    const decoded = JSON.parse(
      Buffer.from(line.slice(MARKER.length), 'base64').toString('utf8'),
    );
    expect(decoded).toEqual({ type: 'message', content: original });
  });

  it('the joined line equals marker + encodeRunnerInput(content)', async () => {
    const content = 'hello world';
    const { pty, textChunks } = fakeTmuxPty();
    await writeRunnerInput(pty, MARKER, content);
    expect(textChunks.join('')).toBe(MARKER + encodeRunnerInput(content));
  });

  it('reports submitted:false and stops sending when a chunk is dropped', async () => {
    const big = 'B'.repeat(15_000);
    const { pty, textChunks, enters } = fakeTmuxPty({ failTextAt: 2 });

    const res = await writeRunnerInput(pty, MARKER, big);

    expect(res).toEqual({ submitted: false });
    // Chunks 0 and 1 landed; chunk 2 failed and we bailed — no Enter.
    expect(textChunks).toHaveLength(2);
    expect(enters).toHaveLength(0);
  });

  it('reports submitted:false when the trailing Enter is dropped', async () => {
    const { pty, enters } = fakeTmuxPty({ failEnter: true });
    const res = await writeRunnerInput(pty, MARKER, 'short message');
    expect(res).toEqual({ submitted: false });
    expect(enters).toHaveLength(0);
  });
});

describe('writeRunnerInput — raw PTY fallback', () => {
  it('writes the whole line + CR in one shot and reports submitted:true', async () => {
    const content = 'fallback path';
    const { pty, writes } = fakeRawPty();
    const res = await writeRunnerInput(pty, MARKER, content);
    expect(res).toEqual({ submitted: true });
    expect(writes).toEqual([MARKER + encodeRunnerInput(content) + '\r']);
  });

  it('reports submitted:false when the raw write throws (pane gone)', async () => {
    const { pty } = fakeRawPty({ throwOnWrite: true });
    const res = await writeRunnerInput(pty, MARKER, 'x');
    expect(res).toEqual({ submitted: false });
  });
});
