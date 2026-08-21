import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scope, Workspace } from '../shared/workspace';
import { WorktreeService, normalizeRemote, worktreeDirName } from './WorktreeService';

// Every dir handed out by tmpDir(), swept in one afterAll — these tests spin
// up several independent roots and repos rather than sharing one temp dir.
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

function initRepo(dir: string, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

function makeScope(dir: string, isGitRepo: boolean): Scope {
  return { id: `scope-${path.basename(dir)}`, name: path.basename(dir), path: dir, isGitRepo, createdAt: Date.now() };
}

function makeWorkspace(scopes: Scope[]): Workspace {
  const now = Date.now();
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    scopes,
    groups: [],
    github: { accountLogin: 'JaviDev', org: 'sprocket' },
    sessions: [],
    createdAt: now,
    updatedAt: now,
  } as Workspace;
}

describe('normalizeRemote', () => {
  it('parses scp-style ssh remotes', () => {
    expect(normalizeRemote('git@github.com:Sprocket/Catalog-Portal.git')).toBe(
      'sprocket/catalog-portal'
    );
  });

  it('parses https remotes with and without .git', () => {
    expect(normalizeRemote('https://github.com/sprocket/forum-admin.git')).toBe(
      'sprocket/forum-admin'
    );
    expect(normalizeRemote('https://github.com/sprocket/forum-admin')).toBe(
      'sprocket/forum-admin'
    );
  });

  it('parses ssh:// remotes', () => {
    expect(normalizeRemote('ssh://git@github.com/sprocket/flextools.git')).toBe(
      'sprocket/flextools'
    );
  });

  it('returns null for remotes it cannot read', () => {
    expect(normalizeRemote('/some/local/path')).toBeNull();
    expect(normalizeRemote('')).toBeNull();
  });
});

describe('worktreeDirName', () => {
  it('is <repo-basename>-<type>-<number>', () => {
    expect(
      worktreeDirName({ provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 })
    ).toBe('catalog-portal-pr-51');
    expect(
      worktreeDirName({ provider: 'github', repo: 'sprocket/media-upload-api', type: 'issue', number: 87 })
    ).toBe('media-upload-api-issue-87');
  });
});

describe('WorktreeService.resolveRepo', () => {
  let repoScope: string;
  let containerScope: string;
  let childClone: string;

  beforeAll(() => {
    repoScope = path.join(tmpDir('consola-wt-repo-'), 'catalog-portal');
    initRepo(repoScope, 'git@github.com:sprocket/catalog-portal.git');

    containerScope = tmpDir('consola-wt-container-');
    childClone = path.join(containerScope, 'forum-admin');
    initRepo(childClone, 'https://github.com/sprocket/forum-admin.git');
    // A non-repo child, to prove the scan skips it quietly.
    fs.mkdirSync(path.join(containerScope, 'notes'), { recursive: true });
  });

  it('matches a repo scope on its origin remote', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true)]);
    expect(service.resolveRepo(workspace, 'sprocket/catalog-portal')).toBe(repoScope);
  });

  it('scans a container scope one level deep', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sprocket/forum-admin')).toBe(childClone);
  });

  it('returns null when no scope holds the repo', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const workspace = makeWorkspace([makeScope(repoScope, true), makeScope(containerScope, false)]);
    expect(service.resolveRepo(workspace, 'sprocket/media-upload-api')).toBeNull();
  });

  it('caches remote lookups until invalidate()', () => {
    const service = new WorktreeService(tmpDir('consola-wt-root-'), async () => 'gh');
    const dir = path.join(tmpDir('consola-wt-cache-'), 'renamed');
    initRepo(dir, 'git@github.com:sprocket/old-name.git');
    const workspace = makeWorkspace([makeScope(dir, true)]);

    expect(service.resolveRepo(workspace, 'sprocket/old-name')).toBe(dir);

    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'git@github.com:sprocket/new-name.git']);
    // Stale until told otherwise — scope changes are what invalidate it.
    expect(service.resolveRepo(workspace, 'sprocket/new-name')).toBeNull();

    service.invalidate();
    expect(service.resolveRepo(workspace, 'sprocket/new-name')).toBe(dir);
  });
});
