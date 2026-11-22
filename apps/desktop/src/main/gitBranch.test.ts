import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NO_BRANCH_FACTS } from '../shared/branchFacts';
import { isPlainBranchName, readBranchFacts, readBranchIdentity } from './gitBranch';

let root: string;
let origin: string;
let clone: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=JaviDev', '-c', 'user.email=javidev@sprocket.example', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
/** Commits `file`, written with `lines` lines, in `repo`. */
const commitFile = (repo: string, file: string, lines: number) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  const text = Array.from({ length: lines }, (_, i) => `line ${i + 1}\n`).join('');
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-m', `add ${file}`);
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-git-branch-')));
  origin = path.join(root, 'origin.git');
  git(root, 'init', '--bare', '-b', 'main', origin);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  git(seed, 'commit', '--allow-empty', '-m', 'initial');
  git(seed, 'push', origin, 'main');

  // A clone, so origin/HEAD is set as it is in a person's own clone.
  clone = path.join(root, 'clone');
  git(root, 'clone', origin, clone);
  git(clone, 'checkout', '-b', 'feat/search-pagination');
  commitFile(clone, 'src/cursor.ts', 3);
  git(clone, 'push', '-u', 'origin', 'feat/search-pagination');
  commitFile(clone, 'src/query.ts', 2);
  commitFile(clone, 'tests/search.test.ts', 4);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * A partial clone of origin at `feat/billing`, missing main's copy of
 * `src/client.ts`, which a diff against origin/main needs.
 */
function partialCloneMissingABlob(): string {
  git(clone, 'checkout', 'main');
  commitFile(clone, 'src/client.ts', 2);
  git(clone, 'push', 'origin', 'main');
  git(clone, 'checkout', '-b', 'feat/billing');
  commitFile(clone, 'src/client.ts', 3);
  git(clone, 'push', 'origin', 'feat/billing');
  git(origin, 'config', 'uploadpack.allowFilter', 'true');
  const partial = path.join(root, 'partial');
  git(root, 'clone', '--filter=blob:none', '--branch', 'feat/billing', `file://${origin}`, partial);
  return partial;
}

describe('readBranchFacts', () => {
  it('counts the commits waiting to be pushed, and those behind when there are some', async () => {
    expect((await readBranchFacts(clone)).upstream).toEqual({
      ref: 'origin/feat/search-pagination',
      ahead: 2,
      behind: 0,
    });

    const other = path.join(root, 'other');
    git(root, 'clone', '--branch', 'feat/search-pagination', origin, other);
    commitFile(other, 'src/page.ts', 1);
    git(other, 'push', 'origin', 'feat/search-pagination');
    // The reads never fetch, so the clone learns of that commit only here.
    git(clone, 'fetch');

    expect((await readBranchFacts(clone)).upstream).toEqual({
      ref: 'origin/feat/search-pagination',
      ahead: 2,
      behind: 1,
    });
  });

  it('has no upstream for a branch that tracks nothing, on a detached HEAD, or when the tracked ref is gone', async () => {
    git(clone, 'checkout', '-b', 'local-only');
    expect((await readBranchFacts(clone)).upstream).toBeNull();

    git(clone, 'checkout', '--detach');
    expect((await readBranchFacts(clone)).upstream).toBeNull();

    git(clone, 'checkout', 'feat/search-pagination');
    git(clone, 'branch', '-dr', 'origin/feat/search-pagination');
    expect((await readBranchFacts(clone)).upstream).toBeNull();
  });

  it("compares the branch with origin's default branch through its merge base", async () => {
    expect((await readBranchFacts(clone)).base).toEqual({
      ref: 'origin/main',
      files: 3,
      additions: 9,
      deletions: 0,
    });
  });

  it("compares with the pull request's base when the clone knows it, else with the default", async () => {
    git(clone, 'push', 'origin', 'main:release');
    git(clone, 'fetch');

    expect((await readBranchFacts(clone, 'release')).base?.ref).toBe('origin/release');
    expect((await readBranchFacts(clone, 'gone')).base?.ref).toBe('origin/main');
  });

  it("draws no base without origin, without origin/HEAD, without a merge base, or when the base is the branch's own upstream", async () => {
    git(clone, 'checkout', 'main');
    const onMain = await readBranchFacts(clone);
    expect(onMain.upstream?.ref).toBe('origin/main');
    expect(onMain.base).toBeNull();

    git(clone, 'checkout', '--orphan', 'unrelated');
    git(clone, 'commit', '--allow-empty', '-m', 'unrelated history');
    expect((await readBranchFacts(clone)).base).toBeNull();

    git(clone, 'checkout', 'feat/search-pagination');
    git(clone, 'remote', 'set-head', 'origin', '-d');
    expect((await readBranchFacts(clone)).base).toBeNull();
    // Named, the base is still found: only the default was missing.
    expect((await readBranchFacts(clone, 'main')).base?.ref).toBe('origin/main');

    git(clone, 'remote', 'remove', 'origin');
    expect((await readBranchFacts(clone, 'main')).base).toBeNull();
  });

  it('ignores a base name that could be read as an option', async () => {
    expect((await readBranchFacts(clone, '--output=/tmp/consola-x')).base?.ref).toBe('origin/main');
    expect(fs.existsSync('/tmp/consola-x')).toBe(false);

    expect(isPlainBranchName('-x')).toBe(false);
    expect(isPlainBranchName('a..b')).toBe(false);
    expect(isPlainBranchName('a b')).toBe(false);
    expect(isPlainBranchName('feat/search-pagination')).toBe(true);
    expect(isPlainBranchName('release-1.2')).toBe(true);
  });

  it('reads with origin pointing nowhere, so nothing it runs reaches the remote', async () => {
    const before = await readBranchFacts(clone);
    expect(before).toMatchObject({ upstream: { ahead: 2 }, base: { ref: 'origin/main' } });

    git(clone, 'remote', 'set-url', 'origin', '/nonexistent/origin.git');
    expect(await readBranchFacts(clone)).toEqual(before);
  });

  it('never fetches a blob a partial clone is missing', async () => {
    // Cloned at the branch, so main's copy of client.ts, which the diff
    // needs, was never fetched.
    const partial = partialCloneMissingABlob();

    expect((await readBranchFacts(partial)).base).toBeNull();

    // git itself would have fetched it, and then the line is there.
    git(partial, 'diff', '--numstat', 'origin/main...HEAD');
    expect((await readBranchFacts(partial)).base).toEqual({
      ref: 'origin/main',
      files: 1,
      additions: 1,
      deletions: 0,
    });
  });

  it('runs nothing against origin, which is there to reach, in any read', async () => {
    // origin is the real bare repo, so a fetch could succeed. Every way git
    // reaches it runs one of these programs, which here leaves a mark and
    // refuses.
    const marker = path.join(root, 'origin-reached');
    const trap = path.join(root, 'trap.sh');
    fs.writeFileSync(trap, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const partial = partialCloneMissingABlob();
    git(clone, 'checkout', 'feat/search-pagination');
    for (const repo of [clone, partial]) {
      git(repo, 'config', 'remote.origin.uploadpack', trap);
      git(repo, 'config', 'remote.origin.receivepack', trap);
    }
    const identity = (url: string) => url;

    expect(await readBranchFacts(clone)).toMatchObject({
      upstream: { ahead: 2 },
      base: { ref: 'origin/main' },
    });
    expect((await readBranchFacts(clone, 'main')).base?.ref).toBe('origin/main');
    expect((await readBranchIdentity(clone, identity))?.branch).toBe('feat/search-pagination');
    expect((await readBranchFacts(partial)).base).toBeNull();
    expect((await readBranchIdentity(partial, identity))?.branch).toBe('feat/billing');
    expect(fs.existsSync(marker)).toBe(false);

    // The trap does catch a fetch: an explicit one, and the one git itself
    // makes to fill a partial clone in.
    expect(() => git(clone, 'fetch')).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    expect(() => git(partial, 'diff', '--numstat', 'origin/main...HEAD')).toThrow();
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('answers no facts for a folder outside git', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await readBranchFacts(plain)).toEqual(NO_BRANCH_FACTS);
  });
});

describe('readBranchIdentity', () => {
  it('names the branch, its name on the remote, and origin', async () => {
    git(clone, 'config', 'branch.feat/search-pagination.merge', 'refs/heads/search-pages');
    const identity = (url: string) => url;

    expect(await readBranchIdentity(clone, identity)).toEqual({
      branch: 'feat/search-pagination',
      remoteBranch: 'search-pages',
      originUrl: origin,
    });

    git(clone, 'checkout', '--detach');
    expect(await readBranchIdentity(clone, identity)).toEqual({
      branch: null,
      remoteBranch: null,
      originUrl: origin,
    });

    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(await readBranchIdentity(plain, identity)).toBeNull();
  });
});
