import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withoutGitHooks } from './gitEnv';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-git-env-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('withoutGitHooks', () => {
  it('stops a hook that lives in the checked-out tree, as husky’s do', () => {
    const repo = path.join(root, 'repo');
    const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
      execFileSync('git', ['-C', repo, ...args], {
        env: {
          ...env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const marker = path.join(root, 'hook-ran');
    fs.mkdirSync(path.join(repo, '.husky'));
    fs.writeFileSync(path.join(repo, '.husky', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    run(['config', 'core.hooksPath', '.husky']);
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);

    run(['checkout', '-q', '-b', 'quiet'], withoutGitHooks(process.env));
    expect(fs.existsSync(marker)).toBe(false);
    // The same checkout without it runs the tree's hook.
    run(['checkout', '-q', '-b', 'loud']);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it.each([
    ['-1', {}],
    ['abc', {}],
    [
      '2.5',
      {
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 't',
        GIT_CONFIG_KEY_1: 'user.email',
        GIT_CONFIG_VALUE_1: 't@t',
      },
    ],
    [
      '2',
      {
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 't',
        GIT_CONFIG_KEY_1: 'user.email',
        GIT_CONFIG_VALUE_1: 't@t',
      },
    ],
  ])('keeps hooks off with GIT_CONFIG_COUNT=%s, in an entry git reads', (count, entries) => {
    const env = withoutGitHooks({ ...entries, GIT_CONFIG_COUNT: count });
    const total = env.GIT_CONFIG_COUNT ?? '';
    expect(total).toMatch(/^\d+$/);
    const index = Array.from({ length: Number(total) }, (_, n) => n).find(
      (n) =>
        env[`GIT_CONFIG_KEY_${n}`] === 'core.hooksPath' &&
        env[`GIT_CONFIG_VALUE_${n}`] === '/dev/null',
    );
    expect(index).toBeDefined();
    // And git agrees: outside any repository, the environment's entry is the answer.
    const answer = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
    });
    expect(answer.trim()).toBe('/dev/null');
  });

  it('appends to config entries already in the environment', () => {
    const env = withoutGitHooks({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 't',
    });
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 't',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
    });
  });
});
