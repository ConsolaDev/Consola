import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GhBroker, layerGhToken } from './GhBroker';

/**
 * A stub `gh` on PATH returning canned output, so the broker is tested
 * end-to-end — real process spawn, real stdout/stderr/exit codes — without
 * network or a keyring. `GH_STUB_LOG` records every invocation, which is how
 * the cache tests count subprocess calls.
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

describe('GhBroker.probe', () => {
  it('reports the binary, version and keyring accounts', async () => {
    const broker = new GhBroker(stubEnv());

    const result = await broker.probe();

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
    const broker = new GhBroker(() => ({ PATH: empty }));

    const result = await broker.probe();

    expect(result.available).toBe(false);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not installed|not on PATH/i);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('is available with zero accounts when nobody is signed in', async () => {
    const broker = new GhBroker(stubEnv({ GH_STUB_MODE: 'logged-out' }));

    const result = await broker.probe();

    expect(result.available).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/not logged in/i);
  });

  it('never carries a token in its result', async () => {
    // This result crosses IPC to the settings UI: the masked token line in
    // `gh auth status` output must not survive parsing in any field.
    const broker = new GhBroker(stubEnv());

    const flat = JSON.stringify(await broker.probe());

    expect(flat).not.toContain('gho_');
  });

  it('never carries a token in its result when the account line is unparseable', async () => {
    // A gh wording parseAccounts doesn't recognize means zero accounts are
    // parsed, which falls back to the raw status text for `error` — this is
    // the one path where a masked token line could ride along unfiltered.
    const broker = new GhBroker(stubEnv({ GH_STUB_MODE: 'unparseable' }));

    const result = await broker.probe();

    expect(result.accounts).toEqual([]);
    expect(result.error).toBeDefined();
    const flat = JSON.stringify(result);
    expect(flat).not.toContain('gho_');
    expect(flat).not.toMatch(/token/i);
  });
});

describe('GhBroker.token', () => {
  it('returns the token gh prints for the account', async () => {
    const broker = new GhBroker(stubEnv());

    await expect(broker.token('SymJavi')).resolves.toBe('gho_stub_token_symjavi');
  });

  it("throws with gh's stderr for an unknown account", async () => {
    const broker = new GhBroker(stubEnv());

    await expect(broker.token('nobody')).rejects.toThrow(/no oauth token found/i);
  });

  it('caches per account within the TTL', async () => {
    const broker = new GhBroker(stubEnv());

    await broker.token('SymJavi');
    await broker.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('re-fetches once the TTL has passed', async () => {
    const broker = new GhBroker(stubEnv(), 0);

    await broker.token('SymJavi');
    await broker.token('SymJavi');

    const tokenCalls = invocations().filter((line) => line.startsWith('auth token'));
    expect(tokenCalls).toHaveLength(2);
  });
});

describe('layerGhToken', () => {
  it('adds GH_TOKEN on top of a copy of the env', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerGhToken(base, 'gho_x');

    expect(layered).toEqual({ PATH: '/usr/bin', GH_TOKEN: 'gho_x' });
    expect(base).not.toHaveProperty('GH_TOKEN');
  });

  it('returns a token-free copy for null', () => {
    const base = { PATH: '/usr/bin' };

    const layered = layerGhToken(base, null);

    expect(layered).toEqual({ PATH: '/usr/bin' });
    expect(layered).not.toBe(base);
  });
});

describe('GhBroker CONSOLA_GH_PATH override', () => {
  // This is the seam Phase 1's unit tests and its Playwright rig depend on to
  // point at a stub `gh` without touching the real binary or the real PATH.

  it('resolves through CONSOLA_GH_PATH even when PATH has nothing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-nogh-'));
    const broker = new GhBroker(() => ({ PATH: empty, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await broker.probe();

    expect(result.available).toBe(true);
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('takes priority over a gh that PATH would also have resolved', async () => {
    const pathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-gh-onpath-'));
    writeStub(pathDir);
    const broker = new GhBroker(() => ({ PATH: pathDir, GH_STUB_LOG: logPath }));
    process.env.CONSOLA_GH_PATH = path.join(dir, 'gh');

    const result = await broker.probe();

    // Both stubs would answer identically; only the resolved path proves
    // which one actually ran.
    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
    fs.rmSync(pathDir, { recursive: true, force: true });
  });

  it('falls back to login-shell PATH resolution when unset', async () => {
    delete process.env.CONSOLA_GH_PATH;
    const broker = new GhBroker(stubEnv());

    const result = await broker.probe();

    expect(result.resolvedBinary).toBe(path.join(dir, 'gh'));
  });
});
