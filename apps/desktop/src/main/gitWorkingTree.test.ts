import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commit, parseStatus, readDiff, readStatus, stageFile, unstageFile } from './gitWorkingTree';

let repo: string;
const gitRaw = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (...args: string[]) => gitRaw(...args).trim();
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
};
const commitAll = (message: string) => {
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
};
// Untrimmed: a name may begin or end with a space.
const staged = () => gitRaw('diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean);

// Each would create a file named PWNED in the repository if a shell ever saw it.
const SPACED_COMMAND = '$(touch PWNED).txt';
const UNSPACED_COMMAND = '$(touch${IFS}PWNED).txt';
const BACKTICKS = '`touch PWNED`.md';
const awkwardNames = ['my notes.md', 'café.md', 'say "hi".txt', 'app/[slug]/page.tsx', ' padded .txt'];
const hostileNames = [SPACED_COMMAND, UNSPACED_COMMAND, BACKTICKS];

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-git-working-tree-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('commit', '-q', '--allow-empty', '-m', 'initial');
});
afterEach(() => {
  // Checked after every test, so a name that reached a shell fails whichever
  // operation let it.
  const pwned = fs.existsSync(path.join(repo, 'PWNED'));
  fs.rmSync(repo, { recursive: true, force: true });
  expect(pwned, 'a file name or message was run as a shell command').toBe(false);
});

describe('parseStatus', () => {
  it('reads -z output: names verbatim, and a rename as its new path', () => {
    const output = ['R  new name.txt', 'old name.txt', '?? café.md', ' M say "hi".txt', ' D gone.txt', 'A  added.ts', ''].join('\0');
    expect(parseStatus(output)).toEqual([
      { path: 'new name.txt', status: 'staged' },
      { path: 'café.md', status: 'untracked' },
      { path: 'say "hi".txt', status: 'modified' },
      { path: 'gone.txt', status: 'deleted' },
      { path: 'added.ts', status: 'staged' },
    ]);
  });
});

describe('readStatus', () => {
  it('lists every name exactly as it is on disk', async () => {
    for (const name of [...awkwardNames, ...hostileNames]) write(name, 'x\n');
    const { files } = await readStatus(repo);
    expect(files.map((f) => f.path).sort()).toEqual([...awkwardNames, ...hostileNames].sort());
    expect(new Set(files.map((f) => f.status))).toEqual(new Set(['untracked']));
  });

  it('lists a staged rename once, under its new name', async () => {
    write('old name.txt', 'x\n');
    commitAll('add');
    git('mv', 'old name.txt', 'new name.txt');
    expect((await readStatus(repo)).files).toEqual([{ path: 'new name.txt', status: 'staged' }]);
  });

  it('counts lines of tracked and untracked changes', async () => {
    write('tracked.txt', 'a\n');
    commitAll('add');
    write('tracked.txt', 'a\nb\nc\n');
    write('my notes.md', 'one\ntwo\n');
    expect((await readStatus(repo)).stats).toEqual({ modifiedCount: 2, addedLines: 4, removedLines: 0 });
  });

  it('answers a folder that is not a repository as not one', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-not-a-repo-'));
    try {
      expect(await readStatus(plain)).toEqual({
        files: [],
        stats: { modifiedCount: 0, addedLines: 0, removedLines: 0 },
        isGitRepo: false,
        branch: null,
      });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('readDiff', () => {
  it.each([...awkwardNames, ...hostileNames])('diffs an untracked, a modified and a staged %j', async (name) => {
    write(name, 'first\n');
    const untracked = await readDiff(repo, name, false);
    expect(untracked).toMatchObject({ isNew: true, isDeleted: false, newContent: 'first\n' });

    commitAll('add');
    write(name, 'first\nsecond\n');
    const modified = await readDiff(repo, name, false);
    expect(modified).toMatchObject({ isNew: false, isDeleted: false, oldContent: 'first\n', newContent: 'first\nsecond\n' });
    expect(modified.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'add').map((l) => l.content)).toEqual(['second']);

    git('add', '--', name);
    const stagedDiff = await readDiff(repo, name, true);
    expect(stagedDiff).toMatchObject({ isNew: false, oldContent: 'first\n', newContent: 'first\nsecond\n' });
  });

  it('diffs a staged new file against nothing', async () => {
    write('my notes.md', 'one\n');
    git('add', '--', 'my notes.md');
    expect(await readDiff(repo, 'my notes.md', true)).toMatchObject({ isNew: true, oldContent: '', newContent: 'one\n' });
  });

  it('diffs a deleted file as deleted', async () => {
    write('my notes.md', 'one\n');
    commitAll('add');
    fs.rmSync(path.join(repo, 'my notes.md'));
    expect(await readDiff(repo, 'my notes.md', false)).toMatchObject({ isDeleted: true, oldContent: 'one\n', newContent: '' });
  });
});

describe('stageFile and unstageFile', () => {
  it.each([...awkwardNames, ...hostileNames])('stages and unstages exactly %j', async (name) => {
    write(name, 'x\n');
    await stageFile(repo, name);
    expect(staged()).toEqual([name]);
    await unstageFile(repo, name);
    expect(staged()).toEqual([]);
  });

  it('stages a bracketed name without also staging what it would match as a pattern', async () => {
    write('app/[slug]/page.tsx', 'x\n');
    write('app/s/page.tsx', 'x\n');
    await stageFile(repo, 'app/[slug]/page.tsx');
    expect(staged()).toEqual(['app/[slug]/page.tsx']);
  });

  it('unstages a change to a committed file, keeping the change', async () => {
    write('my notes.md', 'one\n');
    commitAll('add');
    write('my notes.md', 'one\ntwo\n');
    await stageFile(repo, 'my notes.md');
    await unstageFile(repo, 'my notes.md');
    expect(staged()).toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'my notes.md'), 'utf8')).toBe('one\ntwo\n');
  });

  it("rejects with git's own message when there is nothing to stage", async () => {
    await expect(stageFile(repo, 'vanished.txt')).rejects.toThrow(/vanished\.txt/);
  });
});

describe('commit', () => {
  it('records the message exactly as written', async () => {
    const message = 'fix `touch PWNED` and $(touch PWNED) for "quoted" \\ names';
    write('a.txt', 'x\n');
    git('add', 'a.txt');
    expect(await commit(repo, message)).toEqual({ success: true });
    expect(git('log', '-1', '--format=%B')).toBe(message);
  });

  it("reports git's own error when there is nothing to commit", async () => {
    const result = await commit(repo, 'empty');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nothing/);
  });
});
