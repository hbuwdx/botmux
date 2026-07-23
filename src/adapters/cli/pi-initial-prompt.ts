import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PI_INITIAL_PROMPT_ARG_BYTE_LIMIT = 4096;

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function safeSessionFileStem(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId) && !/^\.+$/.test(sessionId)) return sessionId;
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
}

export function piInitialPromptNeedsFile(prompt: string | undefined): boolean {
  return !!prompt && Buffer.byteLength(prompt, 'utf8') > PI_INITIAL_PROMPT_ARG_BYTE_LIMIT;
}

export function piInitialPromptDir(sessionDataDir: string): string {
  return join(sessionDataDir, 'pi-initial-prompts');
}

export function piInitialPromptFilePath(sessionDataDir: string, sessionId: string): string {
  return join(piInitialPromptDir(sessionDataDir), `${safeSessionFileStem(sessionId)}.prompt.md`);
}

export function preparePiInitialPromptArg(opts: {
  prompt: string;
  sessionId: string;
  sessionDataDir?: string;
}): { initialPromptArg: string; filePath?: string; readonlyRoot?: string } {
  if (!piInitialPromptNeedsFile(opts.prompt)) {
    return { initialPromptArg: opts.prompt };
  }

  const sessionDataDir = opts.sessionDataDir?.trim();
  if (!sessionDataDir) {
    throw new Error('Pi long initial prompt requires SESSION_DATA_DIR for @file delivery; refusing TUI paste fallback');
  }

  const dir = piInitialPromptDir(sessionDataDir);
  mkdirSync(dir, { recursive: true });
  const filePath = piInitialPromptFilePath(sessionDataDir, opts.sessionId);
  writeFileSync(filePath, opts.prompt, { encoding: 'utf8', mode: 0o600 });
  return {
    initialPromptArg: `@${filePath}`,
    filePath,
    readonlyRoot: dir,
  };
}
