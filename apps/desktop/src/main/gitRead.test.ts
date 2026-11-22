import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGit } from './gitRead';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-git-read-')));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Runs `script` through git itself, as one of its shell aliases, so it sees git's environment. */
const throughGit = (script: string) => ['-c', `alias.probe=!${script}`, 'probe'];

describe('readGit', () => {
  it("answers git's output, trimmed", async () => {
    expect(await readGit(root, throughGit('printf "  sprocket\\n\\n"'))).toBe('sprocket');
  });

  it('answers null when git fails', async () => {
    // A folder outside git has no HEAD to name.
    expect(await readGit(root, ['rev-parse', 'HEAD'])).toBeNull();
    expect(await readGit(path.join(root, 'gone'), ['status'])).toBeNull();
  });

  it('answers null when the output is over the buffer, unless the caller makes room', async () => {
    const lines = throughGit('seq 1 100000');
    expect(await readGit(root, lines, { maxBuffer: 1024 })).toBeNull();
    expect((await readGit(root, lines))?.split('\n')).toHaveLength(100_000);
  });

  it('never lets git ask anything, nor fetch what a partial clone is missing', async () => {
    const env = await readGit(
      root,
      throughGit('printf "%s %s" "$GIT_TERMINAL_PROMPT" "$GIT_NO_LAZY_FETCH"'),
    );
    expect(env).toBe('0 1');
  });
});
