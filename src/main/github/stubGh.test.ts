import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

function runStub(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(STUB, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('stub gh fixture', () => {
  it('answers --version', () => {
    expect(runStub(['--version'])).toContain('gh version');
  });

  it('prints a token derived from the requested account', () => {
    expect(runStub(['auth', 'token', '--user', 'SymJavi']).trim()).toBe(
      'gho_stub_token_for_SymJavi'
    );
  });

  it('answers api graphql with the canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(payload.data.reviewRequested.nodes.length).toBeGreaterThan(0);
  });

  it('fails every call with a canned stderr when STUB_GH_FAIL=1', () => {
    expect(() => runStub(['api', 'graphql'], { STUB_GH_FAIL: '1' })).toThrow(/canned failure/);
  });

  it('rejects argv it does not know, so a drifted caller fails loudly', () => {
    expect(() => runStub(['pr', 'merge', '51'])).toThrow();
  });
});
