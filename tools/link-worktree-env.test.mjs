import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isEnvFile, linkEnvFiles, mainCheckoutOf } from './link-worktree-env.mjs';

let scratch;
let main;
let worktree;

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=Sprocket', '-c', 'user.email=ci@sprocket.test', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** A repository shaped like this one, with a linked worktree beside it. */
beforeEach(() => {
  // realpath: macOS's tmpdir is a symlink, and git answers resolved paths.
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'link-worktree-env-')));
  main = join(scratch, 'main');
  worktree = join(scratch, 'worktree');
  mkdirSync(main);
  git(main, 'init', '--quiet', '--initial-branch=main');
  write(join(main, '.gitignore'), '.env*\n!.env.example\n');
  write(join(main, 'apps', 'cloud-api', 'package.json'), '{}');
  write(join(main, 'apps', 'cloud-api', '.env.example'), 'SECRET=\n');
  write(join(main, 'packages', 'sandbox', 'package.json'), '{}');
  git(main, 'add', '.');
  git(main, 'commit', '--quiet', '-m', 'init');
  git(main, 'worktree', 'add', '--quiet', worktree);

  write(join(main, '.env.local'), 'ROOT=acme\n');
  write(join(main, 'apps', 'cloud-api', '.env'), 'SECRET=acme\n');
  write(join(main, 'packages', 'sandbox', '.env'), 'KEY=acme\n');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('isEnvFile', () => {
  it('is .env and .env.<anything>, but not the example', () => {
    for (const name of ['.env', '.env.local', '.env.development.local']) {
      assert.equal(isEnvFile(name), true, name);
    }
    for (const name of ['.env.example', 'env', '.envrc', 'app.env', '.environment']) {
      assert.equal(isEnvFile(name), false, name);
    }
  });
});

describe('mainCheckoutOf', () => {
  it('is the main checkout, from a linked worktree', () => {
    assert.equal(mainCheckoutOf(worktree), main);
  });

  it('is null in the main checkout itself, and outside git', () => {
    assert.equal(mainCheckoutOf(main), null);
    const outside = join(scratch, 'outside');
    mkdirSync(outside);
    assert.equal(mainCheckoutOf(outside), null);
  });
});

describe('linkEnvFiles', () => {
  it("links every env file the main checkout has, at the root and in each package's folder", () => {
    assert.deepEqual(linkEnvFiles(worktree).sort(), [
      '.env.local',
      join('apps', 'cloud-api', '.env'),
      join('packages', 'sandbox', '.env'),
    ]);
    const linked = join(worktree, 'apps', 'cloud-api', '.env');
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    assert.equal(readlinkSync(linked), join(main, 'apps', 'cloud-api', '.env'));
    assert.equal(readFileSync(linked, 'utf8'), 'SECRET=acme\n');
  });

  it('leaves the example alone', () => {
    linkEnvFiles(worktree);
    assert.equal(lstatSync(join(worktree, 'apps', 'cloud-api', '.env.example')).isFile(), true);
  });

  it('never replaces what is already there, and a second run changes nothing', () => {
    write(join(worktree, 'apps', 'cloud-api', '.env'), 'SECRET=mine\n');
    assert.deepEqual(linkEnvFiles(worktree).sort(), [
      '.env.local',
      join('packages', 'sandbox', '.env'),
    ]);
    assert.equal(
      readFileSync(join(worktree, 'apps', 'cloud-api', '.env'), 'utf8'),
      'SECRET=mine\n',
    );
    assert.deepEqual(linkEnvFiles(worktree), []);
  });

  it('skips a package folder the worktree does not have', () => {
    write(join(main, 'apps', 'only-on-main', '.env'), 'X=1\n');
    assert.equal(linkEnvFiles(worktree).includes(join('apps', 'only-on-main', '.env')), false);
  });

  it('links nothing git would not ignore', () => {
    write(join(worktree, '.gitignore'), '');
    assert.deepEqual(linkEnvFiles(worktree), []);
  });

  it('does nothing in the main checkout', () => {
    assert.deepEqual(linkEnvFiles(main), []);
  });
});
