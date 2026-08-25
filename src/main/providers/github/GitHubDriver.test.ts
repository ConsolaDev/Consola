import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { GitHubDriver } from './GitHubDriver';

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
  ✓ Logged in to github.com as SymJavi (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
STATUS
          exit 0
        fi
        cat <<'STATUS'
github.com
  ✓ Logged in to github.com account SymJavi (keyring)
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
        if [ "$4" = "SymJavi" ]; then
          echo "gho_stub_token_symjavi"
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
      { login: 'SymJavi', active: true },
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

    await expect(driver.token('SymJavi')).resolves.toBe('gho_stub_token_symjavi');
  });

  it("throws with gh's stderr for an unknown account", async () => {
    const driver = new GitHubDriver(stubEnv());

    await expect(driver.token('nobody')).rejects.toThrow(/no oauth token found/i);
  });

  it('caches per account within the TTL', async () => {
    const driver = new GitHubDriver(stubEnv());

    await driver.token('SymJavi');
    await driver.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const driver = new GitHubDriver(stubEnv(), 0);

    await driver.token('SymJavi');
    await driver.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('scrubs a leaked token out of a failing token() error, matching how probe() scrubs', async () => {
    // token()'s error rides into InboxService's InboxSnapshot.error, which is
    // broadcast to every renderer — "tokens never cross IPC" is absolute, so
    // this path must strip the same way probe() already does.
    const driver = new GitHubDriver(stubEnv({ GH_STUB_MODE: 'leaky-token-error' }));

    await expect(driver.token('SymJavi')).rejects.toThrow('authentication error');
    await expect(driver.token('SymJavi')).rejects.not.toThrow(/gho_|token/i);
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

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };
const issue87: WorkItemRef = { provider: 'github', repo: 'sympower/msa-resource-bff', type: 'issue', number: 87 };
const binding = { accountLogin: 'SymJavi', org: 'sympower' };

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

  it('runs one gh api graphql request for the three searches and returns merged items', async () => {
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    const items = await driver.fetchInbox(binding, fixtureEnv());

    expect(items).toHaveLength(4);
    expect(items.find((item) => item.workItem.number === 42)?.roles).toEqual([
      'review-requested-direct',
      'assignee',
    ]);
    const [call] = invocations();
    expect(call).toContain('api graphql -f query=');
    expect(call).toContain('-f assigned=assignee:SymJavi is:open archived:false org:sympower');
    expect(call).toContain(
      '-f reviewRequested=review-requested:SymJavi is:open is:pr archived:false org:sympower'
    );
    expect(call).toMatch(/GH_TOKEN=gho_test$/);
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
});

describe('GitHubDriver.checkout', () => {
  beforeEach(() => {
    process.env.CONSOLA_GH_PATH = FIXTURE_GH;
  });

  it('runs gh pr checkout inside the worktree with the token in its env', async () => {
    const clone = path.join(dir, 'controller-app');
    initCloneWithCommit(clone);
    const worktree = path.join(dir, 'controller-app-pr-51');
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
    const source = path.join(dir, 'origin', 'msa-resource-bff');
    initCloneWithCommit(source);
    const target = path.join(dir, 'clones', 'msa-resource-bff');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await driver.cloneRepo('sympower/msa-resource-bff', target, fixtureEnv({ STUB_GH_CLONE_FROM: source }));

    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(invocations()).toEqual([`repo clone sympower/msa-resource-bff ${target} GH_TOKEN=gho_test`]);
  }, 30_000);

  it('rejects with gh stderr when the clone fails, creating nothing', async () => {
    const target = path.join(dir, 'msa-resource-bff');
    const driver = new GitHubDriver(() => ({ PATH: '' }));

    await expect(
      driver.cloneRepo('sympower/msa-resource-bff', target, fixtureEnv({ STUB_GH_FAIL: '1' }))
    ).rejects.toThrow(/canned failure/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('GitHubDriver.matchesRemote', () => {
  const driver = new GitHubDriver(() => ({ PATH: '' }));

  it('matches scp-style, https and ssh remotes, ignoring .git and case', () => {
    expect(driver.matchesRemote('git@github.com:Sympower/Controller-App.git', 'sympower/controller-app')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sympower/flex-portal.git', 'sympower/flex-portal')).toBe(true);
    expect(driver.matchesRemote('https://github.com/sympower/flex-portal', 'Sympower/Flex-Portal')).toBe(true);
    expect(driver.matchesRemote('ssh://git@github.com/sympower/flextools.git', 'sympower/flextools')).toBe(true);
  });

  it('does not match a different repo', () => {
    expect(driver.matchesRemote('git@github.com:sympower/controller-app.git', 'sympower/flex-portal')).toBe(false);
  });

  it('does not match the same owner/name on another host — that is a different repository', () => {
    expect(driver.matchesRemote('git@gitlab.com:sympower/controller-app.git', 'sympower/controller-app')).toBe(false);
    expect(driver.matchesRemote('https://gitlab.com/sympower/controller-app', 'sympower/controller-app')).toBe(false);
  });

  it('does not match remotes it cannot read', () => {
    expect(driver.matchesRemote('/some/local/path', 'sympower/controller-app')).toBe(false);
    expect(driver.matchesRemote('', 'sympower/controller-app')).toBe(false);
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
    url: 'https://github.com/sympower/controller-app/pull/51',
  };

  it('hands its token to subprocesses as GH_TOKEN — the variable gh reads', () => {
    expect(driver.id).toBe('github');
    expect(driver.tokenEnvVar).toBe('GH_TOKEN');
  });

  it('builds github.com URLs', () => {
    expect(driver.workItemUrl(pr51)).toBe('https://github.com/sympower/controller-app/pull/51');
    expect(driver.workItemUrl(issue87)).toBe('https://github.com/sympower/msa-resource-bff/issues/87');
  });

  it('renders the GitHub seed header, titled from the inbox item when there is one', () => {
    expect(driver.seedHeader(pr51, item51)).toBe(
      'This session is for pull request #51 ("Extract billing client") in sympower/controller-app. ' +
        "You are in a dedicated git worktree for it, so the user's own checkout stays untouched. " +
        'Start with `gh pr view 51` to read it.'
    );
    expect(driver.seedHeader(issue87)).toContain('issue #87 ("Issue #87") in sympower/msa-resource-bff');
  });
});
