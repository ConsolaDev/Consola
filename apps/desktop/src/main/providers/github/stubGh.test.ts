// src/main/providers/github/stubGh.test.ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const STUB = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');
const PR = 'https://github.com/sprocket/catalog-portal/pull/51';

function runStub(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(STUB, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    // stderr is piped, not inherited, so a failing case's canned line stays out
    // of the test output; the assertions read it from the thrown error.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('stub gh fixture', () => {
  it('answers --version', () => {
    expect(runStub(['--version'])).toContain('gh version');
  });

  it('prints a token derived from the requested account', () => {
    expect(runStub(['auth', 'token', '--user', 'JaviDev']).trim()).toBe(
      'gho_stub_token_for_JaviDev',
    );
  });

  it('answers api graphql with the five-alias canned inbox payload', () => {
    const payload = JSON.parse(runStub(['api', 'graphql', '-f', 'query=whatever']));
    expect(Object.keys(payload.data)).toEqual([
      'direct',
      'team',
      'authored',
      'assigned',
      'involved',
    ]);
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
    const fresh = [
      'api',
      'graphql',
      '-f',
      'url=https://github.com/sprocket/catalog-portal/pull/51',
      '-f',
      'query=q',
      '--jq',
      '.x',
    ];
    expect(runStub(fresh)).toBe('\n');
    expect(runStub(fresh, { STUB_GH_REVIEWED: 'abc123' })).toBe('abc123\n');
  });

  describe('a poll and its neighbours', () => {
    /** A poll as the re-review template runs it: a query and a `--jq`, no `url=` field. */
    const poll = ['api', 'graphql', '-f', 'query=q', '--jq', '[.data.search.nodes[]]'];

    function inTempDir(test: (dir: string) => void): void {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-poll-'));
      try {
        test(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it('answers a poll with STUB_GH_POLL_FILE', () => {
      inTempDir((dir) => {
        const file = path.join(dir, 'poll.json');
        const items =
          '[{"url":"https://github.com/sprocket/catalog-portal/pull/51","head":"abc"}]\n';
        fs.writeFileSync(file, items);
        expect(runStub(poll, { STUB_GH_POLL_FILE: file })).toBe(items);
        // Unset, or naming no file: nothing at all, never the Inbox's payload.
        expect(runStub(poll)).toBe('');
        expect(runStub(poll, { STUB_GH_POLL_FILE: path.join(dir, 'missing.json') })).toBe('');
      });
    });

    it('the Inbox query still gets its payload', () => {
      inTempDir((dir) => {
        const file = path.join(dir, 'poll.json');
        fs.writeFileSync(file, '[]\n');
        // No --jq: the Inbox's own fetch, which must never read the poll file.
        const payload = JSON.parse(
          runStub(['api', 'graphql', '-f', 'query=whatever'], { STUB_GH_POLL_FILE: file }),
        );
        expect(Object.keys(payload.data)).toContain('direct');
      });
    });

    it('the fresh check still answers STUB_GH_REVIEWED', () => {
      inTempDir((dir) => {
        const file = path.join(dir, 'poll.json');
        fs.writeFileSync(file, '[]\n');
        const fresh = ['api', 'graphql', '-f', `url=${PR}`, '-f', 'query=q', '--jq', '.x'];
        expect(runStub(fresh, { STUB_GH_POLL_FILE: file, STUB_GH_REVIEWED: 'abc123' })).toBe(
          'abc123\n',
        );
      });
    });

    it('STUB_GH_REVIEWED_FROM_POSTED answers the last posted commit for that pull request', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        const fresh = (url: string) => ['api', 'graphql', '-f', `url=${url}`, '-f', 'query=q'];
        const env = {
          STUB_GH_POSTED: posted,
          STUB_GH_REVIEWED_FROM_POSTED: '1',
          // Ignored while the knob above is on.
          STUB_GH_REVIEWED: 'not-this',
        };
        // Nothing posted yet: never reviewed.
        expect(runStub(fresh(PR), env)).toBe('\n');
        const line = (number: number, sha: string) =>
          `api repos/sprocket/catalog-portal/pulls/${number}/reviews -f commit_id=${sha} -f event=COMMENT -F body=@/b BODY=x \n`;
        fs.writeFileSync(posted, line(51, 'aaa') + line(52, 'zzz') + line(51, 'bbb'));
        expect(runStub(fresh(PR), env)).toBe('bbb\n');
        expect(runStub(fresh('https://github.com/sprocket/catalog-portal/pull/52'), env)).toBe(
          'zzz\n',
        );
        expect(runStub(fresh('https://github.com/sprocket/catalog-portal/pull/53'), env)).toBe(
          '\n',
        );
      });
    });

    it('pr checkout --detach follows STUB_GH_PR_HEAD_FILE', () => {
      inTempDir((dir) => {
        const repo = path.join(dir, 'repo');
        const gitIn = (...args: string[]) =>
          execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 't',
              GIT_AUTHOR_EMAIL: 't@t',
              GIT_COMMITTER_NAME: 't',
              GIT_COMMITTER_EMAIL: 't@t',
            },
          }).trim();
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        gitIn('commit', '-q', '--allow-empty', '-m', 'one');
        const first = gitIn('rev-parse', 'HEAD');
        gitIn('commit', '-q', '--allow-empty', '-m', 'two');
        const second = gitIn('rev-parse', 'HEAD');
        const headFile = path.join(dir, 'head');
        const checkout = (env: NodeJS.ProcessEnv) =>
          execFileSync(STUB, ['pr', 'checkout', '51', '--detach'], {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        // No file yet: STUB_GH_PR_HEAD, as before.
        checkout({ STUB_GH_PR_HEAD: first, STUB_GH_PR_HEAD_FILE: headFile });
        expect(gitIn('rev-parse', 'HEAD')).toBe(first);
        // The file, read on every call, wins over STUB_GH_PR_HEAD.
        fs.writeFileSync(headFile, `${second}\n`);
        checkout({ STUB_GH_PR_HEAD: first, STUB_GH_PR_HEAD_FILE: headFile });
        expect(gitIn('rev-parse', 'HEAD')).toBe(second);
        expect(gitIn('rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
      });
    });
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
          `${post(dir).join(' ')} BODY=line one line two \n`,
        );
      });
    });

    it('exits 1 with GitHub’s 422 and posts nothing when STUB_GH_REVIEW_FAIL=1', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        expect(() =>
          runStub(post(dir), { STUB_GH_POSTED: posted, STUB_GH_REVIEW_FAIL: '1' }),
        ).toThrow(
          expect.objectContaining({ status: 1, stderr: 'gh: Unprocessable Entity (HTTP 422)\n' }),
        );
        expect(fs.existsSync(posted)).toBe(false);
      });
    });

    it('is rejected, posting nothing, while STUB_GH_MUTATION_FAILURE_FILE exists', () => {
      inTempDir((dir) => {
        const posted = path.join(dir, 'posted.log');
        const rejecting = path.join(dir, 'reject');
        fs.writeFileSync(rejecting, '');
        expect(() =>
          runStub(post(dir), { STUB_GH_POSTED: posted, STUB_GH_MUTATION_FAILURE_FILE: rejecting }),
        ).toThrow(
          expect.objectContaining({
            status: 1,
            stderr: 'GitHub rejected this action: repository rules are not satisfied.\n',
          }),
        );
        expect(fs.existsSync(posted)).toBe(false);
      });
    });
  });

  it('records argv and the token it saw, one line per call, when STUB_GH_LOG is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-stub-log-'));
    const log = path.join(dir, 'calls.log');

    runStub(['--version'], { STUB_GH_LOG: log, GH_TOKEN: 'gho_a' });
    runStub(['api', 'graphql', '-f', 'query=line one\nline two'], {
      STUB_GH_LOG: log,
      GH_TOKEN: 'gho_b',
    });

    expect(fs.readFileSync(log, 'utf8')).toBe(
      '--version GH_TOKEN=gho_a\napi graphql -f query=line one line two GH_TOKEN=gho_b\n',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
