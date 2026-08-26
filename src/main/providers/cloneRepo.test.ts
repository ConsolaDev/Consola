import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from './GitProviderDriver';
import { cloneWorkspaceRepo, type CloneRepoDeps } from './cloneRepo';
import { createStubDriver } from './stubDriver.test-helpers';

// Every dir handed out by tmpDir(), swept in one afterAll — these tests spin
// up several independent destinations rather than sharing one temp dir.
const createdDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(
  scopePaths: Array<{ path: string; isGitRepo: boolean }>,
  overrides: Partial<Workspace> = {}
): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sympower',
    defaultHarnessId: 'default',
    scopes: scopePaths.map((scope, index) => ({
      id: `scope-${index}`,
      name: path.basename(scope.path),
      path: scope.path,
      isGitRepo: scope.isGitRepo,
      createdAt: now,
    })),
    groups: [],
    provider: { id: 'github', accountLogin: 'SymJavi', org: 'sympower' },
    actions: [],
    sectionDefaults: {},
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * This file's flavour of the shared stub: a token tied to the login, and a
 * cloneRepo that leaves a `.git` marker so the tests can tell a clone
 * happened without running git. The real `gh repo clone` mechanics are
 * GitHubDriver.test.ts's business.
 */
function makeStubDriver(overrides: Partial<GitProviderDriver> = {}): GitProviderDriver {
  return createStubDriver({
    tokenEnvVar: 'STUB_TOKEN',
    token: vi.fn(async (login: string) => `tok-${login}`),
    cloneRepo: vi.fn(async (_repo: string, destinationDir: string) => {
      fs.mkdirSync(path.join(destinationDir, '.git'), { recursive: true });
    }),
    ...overrides,
  });
}

function makeDeps(driver: GitProviderDriver = makeStubDriver(), overrides: Partial<CloneRepoDeps> = {}) {
  const addScope = vi.fn();
  const deps: CloneRepoDeps = {
    resolveDriver: () => driver,
    composeEnv: vi.fn(async (resolved, login) => ({ [resolved.tokenEnvVar]: `tok-${login}` })),
    addScope,
    ...overrides,
  };
  return { deps, addScope, driver };
}

describe('cloneWorkspaceRepo', () => {
  it('clones through the driver into <destination>/<repo basename> with the composed env, leaving scopes alone when a scope covers it', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, addScope, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    const target = path.join(container, 'msa-resource-bff');
    expect(result).toEqual({ ok: true, path: target });
    expect(driver.cloneRepo).toHaveBeenCalledWith('sympower/msa-resource-bff', target, {
      STUB_TOKEN: 'tok-SymJavi',
    });
    expect(fs.existsSync(path.join(target, '.git'))).toBe(true);
    expect(addScope).not.toHaveBeenCalled();
  });

  it('adds a scope for a destination no scope covers', async () => {
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps, addScope } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(true);
    expect(addScope).toHaveBeenCalledWith('ws-1', outside);
  });

  it('refuses when the destination directory does not exist', async () => {
    const missing = path.join(tmpDir('consola-clone-parent-'), 'does-not-exist');
    const workspace = makeWorkspace([{ path: missing, isGitRepo: false }]);
    const { deps, addScope, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', missing);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Destination not found');
    expect(result.error).toContain(missing);
    expect(driver.cloneRepo).not.toHaveBeenCalled();
    expect(addScope).not.toHaveBeenCalled();
  });

  it('refuses when the target directory already exists', async () => {
    const container = tmpDir('consola-clone-dst-');
    fs.mkdirSync(path.join(container, 'msa-resource-bff'));
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
    expect(driver.cloneRepo).not.toHaveBeenCalled();
  });

  it("returns the driver's error on a failed clone, creating nothing", async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(
      makeStubDriver({
        cloneRepo: vi.fn(async () => {
          throw new Error('gh: canned failure (STUB_GH_FAIL=1)');
        }),
      })
    );

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'gh: canned failure (STUB_GH_FAIL=1)' });
    expect(fs.existsSync(path.join(container, 'msa-resource-bff'))).toBe(false);
  });

  it('errors when the provider is unknown to this build', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(makeStubDriver(), {
      resolveDriver: () => {
        throw new Error('Unknown git provider "gitlab".');
      },
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'Unknown git provider "gitlab".' });
  });

  it('errors plainly for a workspace without a provider binding', async () => {
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }], { provider: undefined });
    const { deps, driver } = makeDeps();

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result).toEqual({ ok: false, error: 'This workspace has no provider account bound.' });
    expect(driver.cloneRepo).not.toHaveBeenCalled();
  });

  it('reports the clone succeeded even when adding the scope afterwards throws', async () => {
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps } = makeDeps(makeStubDriver(), {
      addScope: vi.fn(() => {
        throw new Error('No workspace ws-1');
      }),
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(false);
    expect(result.error).toContain(path.join(outside, 'msa-resource-bff'));
    expect(result.error).toContain('No workspace ws-1');
    // The clone itself must not be undone just because the scope-add failed.
    expect(fs.existsSync(path.join(outside, 'msa-resource-bff', '.git'))).toBe(true);
  });
});
