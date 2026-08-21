import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/workspace';
import { cloneWorkspaceRepo, type CloneRepoDeps } from './cloneRepo';

const STUB = path.resolve(__dirname, '../../../tests/fixtures/stub-gh/gh');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A local "origin" for the stub's `repo clone` to clone from. */
function makeSourceRepo(): string {
  const dir = path.join(tmpDir('consola-clone-src-'), 'msa-resource-bff');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@consola.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Consola Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function makeWorkspace(scopePaths: Array<{ path: string; isGitRepo: boolean }>): Workspace {
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
    github: { accountLogin: 'SymJavi', org: 'sympower' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
  } as Workspace;
}

function makeDeps(source: string, overrides: Partial<CloneRepoDeps> = {}) {
  const addScope = vi.fn();
  const deps: CloneRepoDeps = {
    ghBinary: async () => STUB,
    composeEnv: async () => ({ ...process.env, STUB_GH_CLONE_FROM: source, GH_TOKEN: 'gho_test' }),
    addScope,
    ...overrides,
  };
  return { deps, addScope };
}

describe('cloneWorkspaceRepo', () => {
  it('clones into the destination and leaves scopes alone when a scope covers it', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps, addScope } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(container, 'msa-resource-bff'));
    expect(fs.existsSync(path.join(container, 'msa-resource-bff', '.git'))).toBe(true);
    expect(addScope).not.toHaveBeenCalled();
  });

  it('adds a scope for a destination no scope covers', async () => {
    const source = makeSourceRepo();
    const outside = tmpDir('consola-clone-outside-');
    const workspace = makeWorkspace([{ path: tmpDir('consola-clone-other-'), isGitRepo: false }]);
    const { deps, addScope } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', outside);

    expect(result.ok).toBe(true);
    expect(addScope).toHaveBeenCalledWith('ws-1', outside);
  });

  it('refuses when the target directory already exists', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    fs.mkdirSync(path.join(container, 'msa-resource-bff'));
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(source);

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('returns gh stderr on a failed clone, creating nothing', async () => {
    const source = makeSourceRepo();
    const container = tmpDir('consola-clone-dst-');
    const workspace = makeWorkspace([{ path: container, isGitRepo: false }]);
    const { deps } = makeDeps(source, {
      composeEnv: async () => ({ ...process.env, STUB_GH_FAIL: '1', GH_TOKEN: 'gho_test' }),
    });

    const result = await cloneWorkspaceRepo(deps, workspace, 'sympower/msa-resource-bff', container);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('canned failure');
    expect(fs.existsSync(path.join(container, 'msa-resource-bff'))).toBe(false);
  });
});
