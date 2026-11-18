import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeService } from '../WorktreeService';
import { ignoredAtRisk } from './localFiles';

/**
 * The facts that decide whether a removal could lose something git does not
 * count as a change, against real git.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function write(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

let clone: string;
let tree: string;
let service: WorktreeService;

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-facts-')));
  created.push(base);
  clone = path.join(base, 'app');
  const root = path.join(base, 'worktrees');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  write(clone, '.gitignore', '.env\n*.local\nnode_modules/\ndist/\nnotes/\n*.log\n');
  write(clone, 'README', 'hello');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'init');
  tree = path.join(root, 'app-session-1');
  git(clone, 'worktree', 'add', '-q', '-b', 'consola/session-1', tree);
  service = new WorktreeService(root);
});

describe('ignoredAtRisk', () => {
  it('passes a file the main checkout has an identical copy of', async () => {
    write(clone, '.env', 'TOKEN=1');
    write(tree, '.env', 'TOKEN=1');
    expect(await service.ignoredAtRisk(tree, clone)).toEqual({
      count: 0,
      paths: [],
      complete: true,
    });
  });

  it('blocks a modified copy, and a file with no copy at all', async () => {
    write(clone, '.env', 'TOKEN=1');
    write(tree, '.env', 'TOKEN=2');
    write(tree, 'settings.local', 'mine');
    const found = await service.ignoredAtRisk(tree, clone);
    expect(found).toMatchObject({ count: 2, complete: true });
    expect(found.paths[0]).toBe('.env');
  });

  it('looks inside an ignored folder that is not rebuildable', async () => {
    write(tree, 'notes/today.md', 'ideas');
    expect((await service.ignoredAtRisk(tree, clone)).paths).toEqual([
      path.join('notes', 'today.md'),
    ]);
  });

  it('never counts rebuildable folders or disposable files', async () => {
    write(tree, 'node_modules/pkg/index.js', 'x');
    write(tree, 'dist/app.js', 'x');
    write(tree, 'debug.log', 'x');
    expect(await service.ignoredAtRisk(tree, clone)).toEqual({
      count: 0,
      paths: [],
      complete: true,
    });
  });

  it('reads a check cut short by its budget as incomplete', async () => {
    for (let index = 0; index < 5; index++) write(tree, `notes/${index}.md`, 'x');
    const found = await ignoredAtRisk(
      async (cwd, args) => {
        try {
          return {
            code: 0,
            stdout: execFileSync('git', ['-C', cwd, ...args]).toString(),
            stderr: '',
          };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      },
      tree,
      clone,
      {
        deadlineMs: 8_000,
        listedPaths: 5_000,
        visitedEntries: 3,
        comparedBytes: 1024,
        comparedFileBytes: 1024,
      },
    );
    expect(found.complete).toBe(false);
  });
});

describe('nestedRepos', () => {
  it('finds a repository below the root, and none in a plain tree', async () => {
    expect(await service.nestedRepos(tree)).toEqual({ paths: [], complete: true });
    execFileSync('git', ['init', '-q', path.join(tree, 'tools', 'inner')]);
    expect(await service.nestedRepos(tree)).toEqual({
      paths: [path.join('tools', 'inner')],
      complete: true,
    });
  });

  it('skips rebuildable folders', async () => {
    execFileSync('git', ['init', '-q', path.join(tree, 'node_modules', 'dep')]);
    expect((await service.nestedRepos(tree)).paths).toEqual([]);
  });
});

describe('hiddenChanges', () => {
  it('sees through skip-worktree and assume-unchanged, but not an unedited flag', async () => {
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'none' });
    git(tree, 'update-index', '--skip-worktree', 'README');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'none' });
    write(tree, 'README', 'edited where status cannot see');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'some', paths: ['README'] });

    git(tree, 'update-index', '--no-skip-worktree', 'README');
    git(tree, 'checkout', '--', 'README');
    git(tree, 'update-index', '--assume-unchanged', '.gitignore');
    write(tree, '.gitignore', 'changed\n');
    expect(await service.hiddenChanges(tree)).toEqual({ kind: 'some', paths: ['.gitignore'] });
    // git status hides it all the same.
    expect(git(tree, 'status', '--porcelain')).toBe('');
  });
});

describe('inspect', () => {
  it('sees an untracked file even when git is told not to show them', async () => {
    git(clone, 'config', 'status.showUntrackedFiles', 'no');
    write(tree, 'new-file.ts', 'never added');
    expect(git(tree, 'status', '--porcelain')).toBe('');
    expect(await service.inspect(tree)).toMatchObject({ dirty: true, dirtyFiles: 1 });
  });
});

describe('isLocked', () => {
  it('reads git’s lock', async () => {
    expect(await service.isLocked(clone, tree)).toBe(false);
    git(clone, 'worktree', 'lock', tree);
    expect(await service.isLocked(clone, tree)).toBe(true);
  });
});

describe('managedTreeOf', () => {
  it('maps a folder inside a worktree to the worktree, and nothing outside', () => {
    fs.mkdirSync(path.join(tree, 'src'));
    expect(service.managedTreeOf(path.join(tree, 'src'))).toBe(tree);
    expect(service.managedTreeOf(tree)).toBe(tree);
    expect(service.managedTreeOf(clone)).toBeNull();
    expect(service.managedTreeOf(path.dirname(tree))).toBeNull();
    expect(service.managedTreeOf(path.join(path.dirname(tree), 'gone'))).toBeNull();
  });
});
