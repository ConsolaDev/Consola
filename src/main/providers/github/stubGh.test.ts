// src/main/providers/github/stubGh.test.ts
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const STUB = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');

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

  it('answers api graphql with the five-alias canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(Object.keys(payload.data)).toEqual(['direct', 'team', 'authored', 'assigned', 'involved']);
    expect(payload.data.direct.nodes.length).toBeGreaterThan(0);
  });

  it('prints GRAPHQL_INBOX_FIXTURE instead of the canned payload when set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-gh-'));
    const fixture = path.join(dir, 'inbox.json');
    fs.writeFileSync(fixture, JSON.stringify({ data: { direct: { nodes: [] } } }));
    try {
      const payload = JSON.parse(runStub(['api', 'graphql'], { GRAPHQL_INBOX_FIXTURE: fixture }));
      expect(payload).toEqual({ data: { direct: { nodes: [] } } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails every call with a canned stderr when STUB_GH_FAIL=1', () => {
    expect(() => runStub(['api', 'graphql'], { STUB_GH_FAIL: '1' })).toThrow(/canned failure/);
  });

  it('rejects argv it does not know, so a drifted caller fails loudly', () => {
    expect(() => runStub(['pr', 'merge', '51'])).toThrow();
  });

  it('records argv and the token it saw, one line per call, when STUB_GH_LOG is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-log-'));
    const log = path.join(dir, 'calls.log');

    runStub(['--version'], { STUB_GH_LOG: log, GH_TOKEN: 'gho_a' });
    runStub(['api', 'graphql', '-f', 'query=line one\nline two'], { STUB_GH_LOG: log, GH_TOKEN: 'gho_b' });

    expect(fs.readFileSync(log, 'utf8')).toBe(
      '--version GH_TOKEN=gho_a\napi graphql -f query=line one line two GH_TOKEN=gho_b\n'
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
