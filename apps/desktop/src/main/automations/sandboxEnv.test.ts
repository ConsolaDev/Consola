import { describe, expect, it } from 'vitest';
import { sandboxSessionEnv } from './sandboxEnv';

describe("a sandboxed write step's environment (slice 3-B Task 18)", () => {
  it('passes only the allow-list: no token from the login environment, a named variable, the caches, and no git variable (review NB1)', () => {
    const login = {
      HOME: '/h',
      PATH: '/bin',
      USER: 'alice',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      GH_TOKEN: 'gh-dummy',
      GITHUB_TOKEN: 'ghp-dummy',
      AWS_SECRET_ACCESS_KEY: 'aws-dummy',
      NODE_ENV: 'test',
      GIT_DIR: '/h/other/.git',
    };
    const { env, passed, missing } = sandboxSessionEnv(
      login,
      { envVar: 'CLAUDE_CONFIG_DIR', value: '/h/.claude-work' },
      ['NODE_ENV', 'CI'],
      '/w/catalog-portal-run-3f2a91c0',
    );
    const c = '/w/catalog-portal-run-3f2a91c0/.consola-cache';
    expect(env).toEqual({
      HOME: '/h',
      PATH: '/bin',
      USER: 'alice',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      NODE_ENV: 'test',
      CLAUDE_CONFIG_DIR: '/h/.claude-work',
      XDG_CACHE_HOME: c,
      npm_config_cache: `${c}/npm`,
      npm_config_store_dir: `${c}/pnpm-store`,
      YARN_CACHE_FOLDER: `${c}/yarn`,
    });
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'])
      expect(env).not.toHaveProperty(name);
    expect([passed, missing]).toEqual([['NODE_ENV'], ['CI']]);
  });

  it('keeps USER and LOGNAME, which the CLI needs to find its sign-in (canary row 37)', () => {
    const { env } = sandboxSessionEnv(
      {
        HOME: '/h',
        USER: 'alice',
        LOGNAME: 'alice',
        SHELL: '/bin/zsh',
        TMPDIR: '/t/',
        TERM: 'xterm',
      },
      {},
      [],
      '/w/x',
    );
    expect(env).toMatchObject({
      USER: 'alice',
      LOGNAME: 'alice',
      SHELL: '/bin/zsh',
      TMPDIR: '/t/',
      TERM: 'xterm',
    });
  });

  it('a harness that pins nothing keeps its ambient profile, and one with none set leaves the variable out (review B2)', () => {
    expect(
      sandboxSessionEnv(
        { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude-ambient' },
        { envVar: 'CLAUDE_CONFIG_DIR' },
        [],
        '/w/x',
      ).env.CLAUDE_CONFIG_DIR,
    ).toBe('/h/.claude-ambient');
    expect(
      'CLAUDE_CONFIG_DIR' in
        sandboxSessionEnv({ HOME: '/h' }, { envVar: 'CLAUDE_CONFIG_DIR' }, [], '/w/x').env,
    ).toBe(false);
  });

  it('never passes a name that looks like a credential, or a git variable, even when named', () => {
    const { env, passed, missing } = sandboxSessionEnv(
      { HOME: '/h', NPM_TOKEN: 'npm-dummy', GIT_WORK_TREE: '/x' },
      {},
      ['NPM_TOKEN', 'GIT_WORK_TREE'],
      '/w/x',
    );
    expect(env).not.toHaveProperty('NPM_TOKEN');
    expect(env).not.toHaveProperty('GIT_WORK_TREE');
    expect([passed, missing]).toEqual([[], ['NPM_TOKEN', 'GIT_WORK_TREE']]);
  });
});
