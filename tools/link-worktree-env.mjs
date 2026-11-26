// Gives a linked git worktree the main checkout's `.env` files, as symbolic links, so the apps
// start in a fresh worktree without copying secrets around. `pnpm install` runs it
// (`postinstall`), and `pnpm link-env` runs it by hand. It changes nothing in the main checkout,
// in a plain clone (CI) or outside git (a Vercel build), never replaces a file that is already
// there, and links only what git ignores, so a link is never committed.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

/** The folders that may hold an env file: the root, and each workspace package's. */
const PACKAGE_PARENTS = ['apps', 'packages'];

/** `.env` and `.env.<anything>`, but not the committed `.env.example`. */
export function isEnvFile(name) {
  return /^\.env(\..+)?$/.test(name) && !name.endsWith('.example');
}

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * The main checkout of the worktree at `root`, or null when `root` is not a linked worktree:
 * the main checkout itself, a plain clone, a bare repository's worktree, or no git at all.
 */
export function mainCheckoutOf(root, git = runGit) {
  let top;
  let common;
  try {
    top = git(root, ['rev-parse', '--show-toplevel']).trim();
    common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  } catch {
    return null;
  }
  if (basename(common) !== '.git') return null;
  const main = dirname(common);
  return main === top ? null : main;
}

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function subfolders(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function ignoredByGit(root, path, git) {
  try {
    git(root, ['check-ignore', '--quiet', path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Links each env file the main checkout has, in the root or a package folder, into the
 * worktree at `root`, where that folder exists and nothing is at the path yet. Answers the
 * paths it linked, relative to `root`.
 */
export function linkEnvFiles(root, git = runGit) {
  const main = mainCheckoutOf(root, git);
  if (main === null) return [];

  const folders = [root, ...PACKAGE_PARENTS.flatMap((parent) => subfolders(join(root, parent)))];
  const linked = [];
  for (const folder of folders) {
    const mainFolder = join(main, relative(root, folder));
    let names;
    try {
      names = readdirSync(mainFolder);
    } catch {
      continue;
    }
    for (const name of names.filter(isEnvFile)) {
      const source = join(mainFolder, name);
      const target = join(folder, name);
      if (!isFile(source) || present(target) || !ignoredByGit(root, target, git)) continue;
      symlinkSync(source, target);
      linked.push(relative(root, target));
    }
  }
  return linked;
}

const invokedDirectly = process.argv[1] === import.meta.filename;
if (invokedDirectly) {
  // Never fail an install: a link that cannot be made is only a warning.
  try {
    const root = dirname(import.meta.dirname);
    for (const path of linkEnvFiles(root)) {
      console.log(`Linked ${path} from the main checkout.`);
    }
  } catch (error) {
    console.warn(`Could not link the main checkout's .env files: ${error.message}`);
  }
}
