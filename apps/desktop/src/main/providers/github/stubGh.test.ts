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
    expect(runStub(['auth', 'token', '--user', 'JaviDev']).trim()).toBe(
      'gho_stub_token_for_JaviDev'
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
    expect(() => runStub(['pr', 'unsupported-command', '51'])).toThrow();
  });

  it('answers a graphql call with a url= field with STUB_GH_REVIEWED, as its --jq would print it', () => {
    const fresh = ['api', 'graphql', '-f', 'url=https://github.com/sprocket/catalog-portal/pull/51', '-f', 'query=q', '--jq', '.x'];
    expect(runStub(fresh)).toBe('\n');
    expect(runStub(fresh, { STUB_GH_REVIEWED: 'abc123' })).toBe('abc123\n');
  });

  describe('posting a review', () => {
    const post = (dir: string) => [
      'api',
      'repos/sprocket/catalog-portal/pulls/51/reviews',
      '-f',
      'commit_id=abc123',
      '-f',
      'event=REQUEST_CHANGES',
      '-F',
      `body=@${path.join(dir, 'body.md')}`,
    ];

    function inTempDir(test: (dir: string) => void): void {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-review-'));
      try {
        fs.writeFileSync(path.join(dir, 'body.md'), 'line one\nline two\n');
        test(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it('appends argv and the body file, flattened, to STUB_GH_POSTED', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        expect(runStub(post(dir), { STUB_GH_POSTED: posted })).toBe('{"id":1}\n');
        expect(fs.readFileSync(posted, 'utf8')).toBe(
          `${post(dir).join(' ')} BODY=line one line two \n`
        );
      });
    });

    it('exits 1 with GitHub’s 422 and posts nothing when STUB_GH_REVIEW_FAIL=1', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        expect(() => runStub(post(dir), { STUB_GH_POSTED: posted, STUB_GH_REVIEW_FAIL: '1' })).toThrow(
          expect.objectContaining({ status: 1, stderr: 'gh: Unprocessable Entity (HTTP 422)\n' })
        );
        expect(fs.existsSync(posted)).toBe(false);
      });
    });

    it('is rejected, posting nothing, while STUB_GH_MUTATION_FAILURE_FILE exists', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        const rejecting = path.join(dir, 'reject');
        fs.writeFileSync(rejecting, '');
        expect(() => runStub(post(dir), { STUB_GH_POSTED: posted, STUB_GH_MUTATION_FAILURE_FILE: rejecting })).toThrow(
          expect.objectContaining({ status: 1, stderr: 'GitHub rejected this action: repository rules are not satisfied.\n' })
        );
        expect(fs.existsSync(posted)).toBe(false);
      });
    });
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
