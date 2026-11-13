import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { GitHubDriver } from './GitHubDriver';
import { INBOX_SEARCH_ALIASES, searchStrings } from './inboxQuery';

/** The repo-wide canned gh, for the verbs that run real git underneath. */
const FIXTURE_GH = path.resolve(__dirname, '../../../../tests/fixtures/stub-gh/gh');

/**
 * A stub `gh` on PATH returning canned output, so probe() and token() are
 * tested end-to-end — real process spawn, real stdout/stderr/exit codes —
 * without network or a keyring. `GH_STUB_LOG` records every invocation,
 * which is how the cache tests count subprocess calls. Its modes cover gh
 * wordings the fixture gh has no reason to reproduce.
 */
const STUB_SCRIPT = `#!/bin/sh
echo "$@" >> "$GH_STUB_LOG"
case "$1" in
  --version)
    echo "gh version 2.63.1 (2026-01-15)"
    ;;
  auth)
    case "$2" in
      status)
        if [ "$GH_STUB_MODE" = "logged-out" ]; then
          echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
          exit 1
        fi
        if [ "$GH_STUB_MODE" = "unparseable" ]; then
          # Simulates a gh wording parseAccounts doesn't recognize ("as"
          # instead of "account") while still reporting a masked token line,
          # exiting 0 the way a real success report would.
          cat <<'STATUS'
github.com
  ✓ Logged in to github.com as JaviDev (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
STATUS
          exit 0
        fi
        cat <<'STATUS'
github.com
  ✓ Logged in to github.com account JaviDev (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account javier-tarazaga (keyring)
  - Active account: false
  - Git operations protocol: https
STATUS
        ;;
      token)
        if [ "$GH_STUB_MODE" = "leaky-token-error" ]; then
          # A failure whose stderr carries a masked token line alongside a
          # plain-text reason — proves the scrub drops the token line and
          # keeps the rest, rather than either leaking it or losing the
          # whole message.
          echo "authentication error" >&2
          echo "Token: gho_leaked1234567890" >&2
          exit 1
        fi
        if [ "$GH_STUB_MODE" = "token-only-error" ]; then
          # stderr is ONLY a masked token line, nothing else — the case
          # where scrubbing stderr leaves nothing, so a naive fallback would
          # reach for the unscrubbed Node error message instead (which
          # embeds this same stderr verbatim) and leak the token anyway.
          echo "Token: gho_leaked1234567890" >&2
          exit 1
        fi
        if [ "$4" = "JaviDev" ]; then
          echo "gho_stub_token_javidev"
        else
          echo "no oauth token found for account $4" >&2
          exit 1
        fi
        ;;
    esac
    ;;
esac
`;

let dir: string;
let logPath: string;

function stubEnv(extra: Record<string, string> = {}): () => NodeJS.ProcessEnv {
  // The stub dir comes first so the stub shadows any real gh; /bin and
  // /usr/bin let the stub script itself find `cat` and `sh` builtins' helpers.
  return () => ({ PATH: `${dir}:/bin:/usr/bin`, GH_STUB_LOG: logPath, ...extra });
}

/** One line per subprocess call, from whichever stub wrote logPath. */
function invocations(): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
}

function writeStub(targetDir: string): string {
  const stubPath = path.join(targetDir, 'gh');
  fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
  return stubPath;
}

beforeEach(() => {
  // CONSOLA_GH_PATH is a real process.env override (not part of the injected
  // getEnv), so every test starts without it — otherwise a value left over
  // from one test, or from the host shell, would silently redirect another.
  delete process.env.CONSOLA_GH_PATH;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-'));
  logPath = path.join(dir, 'invocations.log');
  writeStub(dir);
});

afterEach(() => {
  delete process.env.CONSOLA_GH_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GitHubDriver.probe', () => {
  it('reports the binary, version and keyring accounts', async () => {
    const driver = new GitHubDriver(stubEnv());

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    expect(result.version).toBe('2.63.1');
    expect(result.accounts).toEqual([
      { login: 'JaviDev', active: true },
      { login: 'javier-tarazaga', active: false },
    ]);
    expect(result.error).toBeUndefined();
  });

  it('degrades to unavailable when gh is not on PATH', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const driver = new GitHubDriver(() => ({ PATH: empty }));

    const result = await driver.probe();

    expect(result.available).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not installed|not on PATH/i);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("blames the login shell, not the install, when Consola never got the shell's PATH", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const problem = '`/bin/zsh -ilc` did not finish within 20s';
    const driver = new GitHubDriver(() => ({ PATH: empty }), undefined, () => problem);

    const result = await driver.probe();

    expect(result.available).toBe(false);
    expect(result.error).toContain(problem);
    expect(result.error).toMatch(/Restart Consola/);
    expect(result.error).not.toMatch(/not installed/);
    await expect(driver.token('JaviDev')).rejects.toThrow(problem);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('is available with zero accounts when nobody is signed in', async () => {
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'logged-out' }));

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not logged in/i);
  });

  it('never carries a token in its result', async () => {
    // This result crosses IPC to the settings UI: the masked token line in
    // `gh auth status` output must not survive parsing in any field.
    const driver = new GitHubDriver(stubEnv());

    const flat = JSON.stringify(await driver.probe());

    expect(flat).not.toContain('gho_');
  });

  it('never carries a token in its result when the account line is unparseable', async () => {
    // A gh wording parseAccounts doesn't recognize means zero accounts are
    // parsed, which falls back to the raw status text for `error` — this is
    // the one path where a masked token line could ride along unfiltered.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'unparseable' }));

    const result = await driver.probe();

    expect(result.accounts).toEqual([]);
    expect(result.error).toBeDefined();
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('gho_');
    expect(flat).not.toMatch(/token/i);
  });
});

describe('GitHubDriver.token', () => {
  it('returns the token gh prints for the account', async () => {
    const driver = new GitHubDriver(stubEnv());

    await expect(driver.token('JaviDev')).resolves.toBe('gho_stub_token_javidev');
  });

  it("throws with gh's stderr for an unknown account", async () => {
    const driver = new GitHubDriver(stubEnv());

    await expect(driver.token('nobody')).rejects.toThrow(/no oauth token found/i);
  });

  it('caches per account within the TTL', async () => {
    const driver = new GitHubDriver(stubEnv());

    await driver.token('JaviDev');
    await driver.token('JaviDev');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const driver = new GitHubDriver(stubEnv(), 0);

    await driver.token('JaviDev');
    await driver.token('JaviDev');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('scrubs a leaked token out of a failing token() error, matching how probe() scrubs', async () => {
    // token()'s error rides into InboxService's InboxSnapshot.error, which is
    // broadcast to every renderer — "tokens never cross IPC" is absolute, so
    // this path must strip the same way probe() already does.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'leaky-token-error' }));

    await expect(driver.token('JaviDev')).rejects.toThrow('authentication error');
    await expect(driver.token('JaviDev')).rejects.not.toThrow(/gho_|token/i);
  });

  it('never falls back to the raw, unscrubbed subprocess error when stderr scrubs to nothing', async () => {
    // Regression: the fallback below stripTokenLines(stderr) used to be the
    // unscrubbed Node error message, which embeds stderr verbatim (via
    // "Command failed: ..."). When stderr is ONLY a masked token line,
    // scrubbing it leaves "" — exactly the case that used to fall through
    // to the raw message and leak the token anyway. The rejection must
    // still be non-empty (the literal fallback), never the leaked value.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'token-only-error' }));

    let message = '';
    try {
      await driver.token('JaviDev');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toMatch(/gho_/);
    expect(message).not.toMatch(/token/i);
    expect(message.length).toBeGreaterThan(0);
  });
});

describe('GitHubDriver CONSOLA_GH_PATH override', () => {
  // This is the seam the unit tests and the Playwright rig depend on to
  // point at a stub `gh` without touching the real binary or the real PATH.

  it('resolves through CONSOLA_GH_PATH even when PATH has nothing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const driver = new GitHubDriver(() => ({ PATH: empty, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await driver.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('takes priority over a gh that PATH would also have resolved', async () => {
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-onpath-'));
    writeStub(pathDir);
    const driver = new GitHubDriver(() => ({ PATH: pathDir, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await driver.probe();

    // Both stubs would answer identically; only the resolved path proves
    // which one actually ran.
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(pathDir, { recursive: true, force: true });
  });

  it('falls back to login-shell PATH resolution when unset', async () => {
    delete process.env.CONSOLA_GH_PATH;
    const driver = new GitHubDriver(stubEnv());

    const result = await driver.probe();

    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
  });
});

// --- The fixture gh: real argv, real env, real git for the seam's other verbs. ---

const pr51: WorkItemRef = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sprocket/media-upload-api', type: 'issue', number: 87 };
const binding = { accountLogin: 'JaviDev', org: 'sprocket' };

/** What a caller composes: the process env plus the borrowed token, plus the fixture's log knob. */
function fixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, STUB_GH_LOG: logPath, GH_TOKEN: 'gho_test', ...extra };
}

function initCloneWithCommit(target: string): void {
  fs.mkdirSync(target, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', target]);
  execFileSync('git', ['-C', target, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', target, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture');
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, 'commit', '-q', '-m', 'init']);
}

function currentBranch(target: string): string {
  return execFileSync('git', ['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

describe('GitHubDriver.fetchInbox', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('sends one gh api graphql call carrying the query and all five searches, with the token env', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    const items = await driver.fetchInbox(binding, fixtureEnv());

    expect(items).toHaveLength(9);
    const [call] = invocations();
    expect(call).toContain('api graphql -f query=');
    const searches = searchStrings('JaviDev', 'sprocket');
    for (const alias of INBOX_SEARCH_ALIASES) {
      expect(call).toContain(`-f ${alias}=${searches[alias]}`);
    }
    // One -f for the query, one per alias -- nothing under the old three-alias names.
    expect(call.match(/ -f /g)).toHaveLength(INBOX_SEARCH_ALIASES.length + 1);
    expect(call).not.toContain('reviewRequested=');
    expect(call).toMatch(/GH_TOKEN=gho_test$/);
  });

  it('propagates a parser rejection instead of answering with an empty inbox', async () => {
    const broken = path.join(dir, 'broken-inbox.json');
    fs.writeFileSync(broken, JSON.stringify({ data: null }));
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(
      driver.fetchInbox(binding, fixtureEnv({ GRAPHQL_INBOX_FIXTURE: broken }))
    ).rejects.toThrow('GitHub API returned no data');
  });

  it('rejects with gh stderr when the request fails', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.fetchInbox(binding, fixtureEnv({ STUB_GH_FAIL: '1' }))).rejects.toThrow(
      /canned failure/
    );
  });

  it('throws on a reply it does not recognise rather than returning an empty inbox', async () => {
    // A gh answering with a JSON string, not an object: the driver must
    // refuse, or a broken gh would read as "nothing to do".
    const garbage = path.join(dir, 'garbage-gh');
    fs.writeFileSync(garbage, '#!/bin/sh\necho \'"not an inbox"\'\n', { mode: 0o755 });
    process.env.CONSOLA_GH_PATH = garbage;
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.fetchInbox(binding, fixtureEnv())).rejects.toThrow(
      'Inbox payload must be a JSON object'
    );
  });

  it('names the verb and exit code, never the full argv, when gh fails with empty stderr', async () => {
    // fetchInbox's argv carries the whole multi-KB GraphQL query — a bare
    // error.message fallback would put that in a user-facing message
    // (InboxSnapshot.error, broadcast to every renderer). A gh that fails
    // silently (empty stderr) is the case that used to fall back to it.
    const silent = path.join(dir, 'silent-fail-gh');
    fs.writeFileSync(silent, '#!/bin/sh\nexit 2\n', { mode: 0o755 });
    process.env.CONSOLA_GH_PATH = silent;
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    let message = '';
    try {
      await driver.fetchInbox(binding, fixtureEnv());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // An exact match, not just a substring check: proves the message is
    // only the verb/noun and exit code, with no room for the argv to hide.
    expect(message).toBe('gh api graphql failed (exit 2).');
  });
});

describe('GitHubDriver.checkout', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs gh pr checkout inside the worktree with the token in its env', async () => {
    const clone = path.join(dir, 'catalog-portal');
    initCloneWithCommit(clone);
    const worktree = path.join(dir, 'catalog-portal-pr-51');
    execFileSync('git', ['-C', clone, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' });
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.checkout(worktree, pr51, fixtureEnv());

    expect(currentBranch(worktree)).toBe('stub-pr-51'); // the stub's checkout branch
    expect(invocations()).toEqual(['pr checkout 51 GH_TOKEN=gho_test']);
  }, 30_000);

  it('does nothing for an issue — there is no remote branch to fetch', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.checkout(dir, issue87, fixtureEnv());

    expect(invocations()).toEqual([]);
  });

  it('rejects with gh stderr when the checkout fails', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(driver.checkout(dir, pr51, fixtureEnv({ STUB_GH_FAIL: '1' }))).rejects.toThrow(
      /gh: canned failure \(STUB_GH_FAIL=1\)/
    );
  });
});

describe('GitHubDriver.cloneRepo', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs gh repo clone <repo> <dir> with the token in its env', async () => {
    const source = path.join(dir, 'origin', 'media-upload-api');
    initCloneWithCommit(source);
    const target = path.join(dir, 'clones', 'media-upload-api');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.cloneRepo('sprocket/media-upload-api', target, fixtureEnv({ STUB_GH_CLONE_FROM: source }));

    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(invocations()).toEqual([`repo clone sprocket/media-upload-api ${target} GH_TOKEN=gho_test`]);
  }, 30_000);

  it('rejects with gh stderr when the clone fails, creating nothing', async () => {
    const target = path.join(dir, 'media-upload-api');
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(
      driver.cloneRepo('sprocket/media-upload-api', target, fixtureEnv({ STUB_GH_FAIL: '1' }))
    ).rejects.toThrow(/canned failure/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('GitHubDriver.matchesRemote', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));

  it('matches scp-style, https and ssh remotes, ignoring .git and case', () => {
    expect(driver.matchesRemote('git@github.com:Sprocket/Catalog-Portal.git', 'sprocket/catalog-portal')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sprocket/forum-admin.git', 'sprocket/forum-admin')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sprocket/forum-admin', 'Sprocket/Forum-Admin')).toBe(true);
    expect(driver.matchesRemote('ssh://git@github.com/sprocket/flextools.git', 'sprocket/flextools')).toBe(true);
  });

  it('does not match a different repo', () => {
    expect(driver.matchesRemote('git@github.com:sprocket/catalog-portal.git', 'sprocket/forum-admin')).toBe(false);
  });

  it('does not match the same owner/name on another host — that is a different repository', () => {
    expect(driver.matchesRemote('git@gitlab.com:sprocket/catalog-portal.git', 'sprocket/catalog-portal')).toBe(false);
    expect(driver.matchesRemote('https://gitlab.com/sprocket/catalog-portal', 'sprocket/catalog-portal')).toBe(false);
  });

  it('does not match remotes it cannot read', () => {
    expect(driver.matchesRemote('/some/local/path', 'sprocket/catalog-portal')).toBe(false);
    expect(driver.matchesRemote('', 'sprocket/catalog-portal')).toBe(false);
  });
});

describe('GitHubDriver.isPrivateAsset', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));
  const is = (href: string) => driver.isPrivateAsset(new URL(href));

  it('claims uploads pasted into a PR or issue', () => {
    expect(is('https://github.com/user-attachments/assets/3c9d2a71-8e4f-4b6a-a1d2-5f0e7b9c4d18')).toBe(true);
    expect(is('https://github.com/sprocket/catalog-portal/assets/1234567/0b6f1e7a-5d2c-4c1e-9a3b-2f8d7c6e5a4b')).toBe(true);
  });

  it('offers the token to github.com over https and nowhere else', () => {
    expect(is('http://github.com/user-attachments/assets/3c9d2a71')).toBe(false);
    expect(is('https://github.com.evil.example/user-attachments/assets/3c9d2a71')).toBe(false);
    expect(is('https://evil.example/user-attachments/assets/3c9d2a71')).toBe(false);
    expect(is('https://github.com:8443/user-attachments/assets/3c9d2a71')).toBe(false);
    expect(is('https://someone@github.com/user-attachments/assets/3c9d2a71')).toBe(false);
  });

  it('leaves public images and other GitHub pages alone', () => {
    expect(is('https://user-images.githubusercontent.com/1/abc.png')).toBe(false);
    expect(is('https://github.com/user-attachments/files/123/report.pdf')).toBe(false);
    expect(is('https://github.com/sprocket/catalog-portal/pull/51')).toBe(false);
    expect(is('https://github.com/sprocket/catalog-portal/assets/12/../../settings')).toBe(false);
  });
});

describe('GitHubDriver identity, URLs and header', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));
  const item51: InboxItem = {
    workItem: pr51,
    title: 'Extract billing client',
    author: 'anna',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    ciStatus: 'failing',
    commentCount: 3,
    updatedAt: '2026-08-20T07:55:00Z',
    url: 'https://github.com/sprocket/catalog-portal/pull/51',
  };

  it('hands its token to subprocesses as GH_TOKEN — the variable gh reads', () => {
    expect(driver.id).toBe('github');
    expect(driver.tokenEnvVar).toBe('GH_TOKEN');
  });

  it('builds github.com URLs', () => {
    expect(driver.workItemUrl(pr51)).toBe('https://github.com/sprocket/catalog-portal/pull/51');
    expect(driver.workItemUrl(issue87)).toBe('https://github.com/sprocket/media-upload-api/issues/87');
  });

  it('renders the GitHub seed header, titled from the inbox item when there is one', () => {
    expect(driver.seedHeader(pr51, item51)).toBe(
      'This session is for pull request #51 ("Extract billing client") in sprocket/catalog-portal. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh pr view 51` to read it.'
    );
    expect(driver.seedHeader(issue87)).toContain('issue #87 ("Issue #87") in sprocket/media-upload-api');
  });
});

describe('GitHubDriver.lookupPullRequests', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  const pull = (number: number, extra: Record<string, unknown> = {}) => ({
    number,
    state: 'closed',
    merged_at: '2026-10-01T10:00:00Z',
    html_url: `https://github.com/acme/app/pull/${number}`,
    created_at: '2026-09-01T10:00:00Z',
    head: { sha: 'b'.repeat(40), ref: `branch-${number}` },
    ...extra,
  });

  function pullsFixture(lines: Record<string, unknown>): Record<string, string> {
    const file = path.join(dir, 'pulls.txt');
    fs.writeFileSync(
      file,
      Object.entries(lines)
        .map(([endpoint, body]) => `${endpoint} ${JSON.stringify(body)}`)
        .join('\n')
    );
    return { STUB_GH_PULLS: file };
  }

  it('answers each query in order, by number and by head branch, with the token env', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));
    const env = fixtureEnv(
      pullsFixture({
        'repos/acme/app/pulls/51': pull(51),
        'repos/acme/app/pulls?state=all&per_page=20&head=acme%3Afeature': [
          pull(60, { state: 'open', merged_at: null }),
        ],
      })
    );

    const result = await driver.lookupPullRequests(
      [
        { repo: 'acme/app', number: 51 },
        { repo: 'acme/app', headBranch: 'feature' },
      ],
      env
    );

    expect(result.map((lookup) => lookup.pullRequests.map((pr) => [pr.number, pr.status]))).toEqual([
      [[51, 'merged']],
      [[60, 'open']],
    ]);
    const calls = invocations();
    expect(calls).toHaveLength(2);
    expect(calls).toContain('api repos/acme/app/pulls/51 --hostname github.com GH_TOKEN=gho_test');
  });

  it('fails one query without failing the batch', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));
    const env = fixtureEnv(pullsFixture({ 'repos/acme/app/pulls/51': pull(51) }));

    const [found, missing, invalid] = await driver.lookupPullRequests(
      [
        { repo: 'acme/app', number: 51 },
        { repo: 'acme/app', number: 404 },
        { repo: '../escape', number: 1 },
      ],
      env
    );

    expect(found.error).toBeUndefined();
    expect(missing).toMatchObject({ pullRequests: [], error: expect.stringMatching(/Not Found/) });
    expect(invalid.error).toMatch(/owner\/name/);
    // The invalid query never reached gh.
    expect(invocations()).toHaveLength(2);
  });

  it('names the repository behind a GitHub remote, and nothing else', () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));
    expect(driver.repoOfRemote('git@github.com:Acme/App.git')).toBe('acme/app');
    expect(driver.repoOfRemote('https://gitlab.com/acme/app')).toBeNull();
  });
});
