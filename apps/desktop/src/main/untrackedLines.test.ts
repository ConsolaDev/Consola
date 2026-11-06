import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countUntrackedLines, readUntrackedFile } from './untrackedLines';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** What git itself would add for these files, were they marked intent-to-add. */
function gitAddedLines(paths: string[]): number {
  git('add', '--intent-to-add', '--', ...paths);
  try {
    return git('diff', '--numstat')
      .split('\n')
      .filter(Boolean)
      .reduce((sum, line) => sum + (parseInt(line.split('\t')[0], 10) || 0), 0);
  } finally {
    git('reset', '--quiet', '--', ...paths);
  }
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-untracked-lines-')));
  git('init', '-b', 'main');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('countUntrackedLines', () => {
  it('counts the lines git would add for new text files', async () => {
    const files: Record<string, string> = {
      'trailing-newline.txt': 'one\ntwo\nthree\n',
      'no-trailing-newline.txt': 'one\ntwo',
      'blank-lines.txt': '\n\n\n',
      'empty.txt': '',
      'nested/deep/file.ts': 'export const x = 1;\n',
    };
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    const paths = Object.keys(files);

    const counted = await countUntrackedLines(repo, paths);
    expect(counted).toBe(3 + 2 + 3 + 0 + 1);
    expect(counted).toBe(gitAddedLines(paths));
  });

  it('counts a file larger than one read chunk', async () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    fs.writeFileSync(path.join(repo, 'big.log'), lines);
    expect(await countUntrackedLines(repo, ['big.log'])).toBe(50_000);
    expect(gitAddedLines(['big.log'])).toBe(50_000);
  });

  it('counts no lines for a binary file, as git does', async () => {
    fs.writeFileSync(path.join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a, 0x1a]));
    expect(await countUntrackedLines(repo, ['image.png'])).toBe(0);
    expect(gitAddedLines(['image.png'])).toBe(0);
  });

  it('counts no lines for a text file .gitattributes marks binary or -diff, as git does', async () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.lock binary\n*.snap -diff\n');
    git('add', '.gitattributes');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'attributes');
    fs.writeFileSync(path.join(repo, 'deps.lock'), 'a\nb\nc\n');
    fs.writeFileSync(path.join(repo, 'view.snap'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, 'counted.txt'), 'a\n');
    const paths = ['deps.lock', 'view.snap', 'counted.txt'];

    expect(await countUntrackedLines(repo, paths)).toBe(1);
    expect(gitAddedLines(paths)).toBe(1);
  });

  it('counts a symlink as the one line git diffs it as', async () => {
    fs.mkdirSync(path.join(repo, 'target-dir'));
    fs.symlinkSync('target-dir', path.join(repo, 'link'));
    expect(await countUntrackedLines(repo, ['link'])).toBe(1);
    expect(gitAddedLines(['link'])).toBe(1);
  });

  it('counts nothing for a path that is gone or is a directory', async () => {
    fs.mkdirSync(path.join(repo, 'nested-repo'));
    expect(await countUntrackedLines(repo, ['vanished.txt', 'nested-repo/'])).toBe(0);
  });
});

describe('readUntrackedFile', () => {
  it('reads a text file as text', async () => {
    fs.writeFileSync(path.join(repo, 'notes.md'), '# Notes\n');
    expect(await readUntrackedFile(repo, 'notes.md')).toEqual({ content: '# Notes\n', isBinary: false });
  });

  // The review panel shows this file's content and counts its lines; calling
  // binary exactly what the header counts as no lines keeps the two in step.
  it('reads a file with a NUL as binary, with no content', async () => {
    fs.writeFileSync(path.join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x0a]));
    expect(await readUntrackedFile(repo, 'image.png')).toEqual({ content: '', isBinary: true });
  });

  it('reads a file .gitattributes marks binary as binary', async () => {
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.lock binary\n');
    fs.writeFileSync(path.join(repo, 'deps.lock'), 'a\nb\n');
    expect(await readUntrackedFile(repo, 'deps.lock')).toEqual({ content: '', isBinary: true });
  });

  it('reads a symlink as its target path, which is what git diffs', async () => {
    fs.writeFileSync(path.join(repo, 'real.txt'), 'one\ntwo\n');
    fs.symlinkSync('real.txt', path.join(repo, 'link'));
    expect(await readUntrackedFile(repo, 'link')).toEqual({ content: 'real.txt', isBinary: false });
  });

  it('answers null for a file that is gone', async () => {
    expect(await readUntrackedFile(repo, 'vanished.txt')).toBeNull();
  });
});
