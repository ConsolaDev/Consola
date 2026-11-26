// Vercel's ignored build step (`ignoreCommand` in vercel.json): decides whether a push deploys the
// website. Vercel builds when this exits 1, and skips the deployment (marking it canceled) when it
// exits 0.
//
// Vercel uploads only the files `.vercelignore` lets through, so nothing else can change the site.
// Production (main) deploys when any of them changed since the commit it last deployed. They
// include the desktop's renderer, which the demo bundles, so the site never shows an older app.
// A preview deploys only for the website's own files (`OWN_FILES`): previews of every pull request
// that touches the desktop are what this exists to stop. A branch that has no deployment yet is
// compared with where it left main.
//
// The commits are fetched from GitHub into a throwaway repository, commits only, with the folder
// listings the comparison reads fetched as it reads them and no file contents. So the answer never
// depends on what Vercel's own checkout kept of the history. Anything this cannot answer deploys,
// as every push did before it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The branch Vercel deploys to production. */
export const PRODUCTION_BRANCH = 'main';

/**
 * The website's own files among its inputs: its folder and its deployment's configuration. A
 * preview deploys only for these. An entry ending in `/` is a folder.
 */
export const OWN_FILES = [
  'apps/website/',
  '.vercelignore',
  'tools/vercel-ignore.mjs',
  'vercel.json',
];

/** The build log names at most this many of the changed files. */
const LISTED = 20;

/**
 * The paths the site is built from: each one `.vercelignore` lets through with nothing let through
 * beneath it, a file or a whole folder. A folder above them (`!apps`) only opens the way to them.
 * The file must stay an allow-list (`*`, then `!path` and `!folder/**` rules), and anything else
 * throws: a misread list would skip deployments the site needed.
 *
 * @param {string} vercelignore
 * @returns {string[]}
 */
export function inputsOf(vercelignore) {
  const rules = vercelignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  if (rules[0] !== '*') {
    throw new Error('.vercelignore does not start with `*`, so it is no longer an allow-list.');
  }
  const paths = new Set();
  for (const rule of rules.slice(1)) {
    const path = /^!([^\s*?[\]\\!/][^*?[\]\\!]*?)\/?(\/\*\*)?$/.exec(rule)?.[1];
    if (!path) throw new Error(`.vercelignore has a rule this cannot read: \`${rule}\``);
    paths.add(path);
  }
  const all = [...paths];
  return all.filter((path) => !all.some((other) => other.startsWith(`${path}/`))).sort();
}

/**
 * The inputs a preview deploys for: those among the website's own files. A file of the website's
 * folder that is not uploaded (its tests, its README) is not one.
 *
 * @param {string[]} inputs
 * @returns {string[]}
 */
export function previewInputsOf(inputs) {
  return inputs.filter((input) =>
    OWN_FILES.some((own) => (own.endsWith('/') ? input.startsWith(own) : input === own)),
  );
}

const isInput = (file, inputs) =>
  inputs.some((input) => file === input || file.startsWith(`${input}/`));

/**
 * @typedef {{ sha: string, name: string } | { branch: string, name: string }} Base
 * @typedef {{ repo: string, head: string, production: boolean, base: Base }} Comparison
 */

/**
 * What a deployment is compared with, read from Vercel's system environment variables, or null
 * when they do not say (a deployment that did not come from GitHub, such as `vercel deploy`).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Comparison | null}
 */
export function comparisonFor(env) {
  const head = env.VERCEL_GIT_COMMIT_SHA;
  const owner = env.VERCEL_GIT_REPO_OWNER;
  const slug = env.VERCEL_GIT_REPO_SLUG;
  if (env.VERCEL_GIT_PROVIDER !== 'github' || !head || !owner || !slug) return null;
  const previous = env.VERCEL_GIT_PREVIOUS_SHA;
  return {
    repo: `https://github.com/${owner}/${slug}.git`,
    head,
    // Either says production, so a missing variable never narrows a production deployment.
    production: env.VERCEL_ENV === 'production' || env.VERCEL_GIT_COMMIT_REF === PRODUCTION_BRANCH,
    base: previous
      ? { sha: previous, name: 'the commit last deployed on this branch' }
      : { branch: PRODUCTION_BRANCH, name: `where this branch left ${PRODUCTION_BRANCH}` },
  };
}

/**
 * Whether to deploy, and the lines that say why.
 *
 * @param {{
 *   env: Record<string, string | undefined>,
 *   readVercelignore: () => string,
 *   changes: (comparison: Comparison) => { base: string, files: string[] },
 * }} io `changes` names the base commit it compared with and every file changed since it.
 * @returns {{ deploy: boolean, reason: string }}
 */
export function decide({ env, readVercelignore, changes }) {
  const deployAnyway = (why) => ({
    deploy: true,
    reason: `Deploying, since this cannot tell whether the site changed: ${why}`,
  });
  try {
    const all = inputsOf(readVercelignore());
    const comparison = comparisonFor(env);
    if (!comparison) return deployAnyway('Vercel did not say which GitHub commit this is.');
    const { base, files } = changes(comparison);
    const short = (sha) => sha.slice(0, 7);
    if (base === comparison.head) {
      // A branch pushed with no commit of its own: there is nothing to preview.
      if (!comparison.production && 'branch' in comparison.base) {
        return {
          deploy: false,
          reason: `Skipping: ${short(base)} is already on ${PRODUCTION_BRANCH}, so this branch has nothing of its own to preview.`,
        };
      }
      // A redeploy, or production's first deployment.
      return {
        deploy: true,
        reason: `Deploying: ${short(base)} is ${comparison.base.name}, so there is nothing to compare it with.`,
      };
    }
    const [inputs, what] = comparison.production
      ? [all, 'the files the site is built from']
      : [previewInputsOf(all), "the website's own files (a preview ignores the desktop's)"];
    const since = `since ${comparison.base.name} (${short(base)})`;
    const changed = files.filter((file) => isInput(file, inputs));
    if (changed.length === 0) {
      return {
        deploy: false,
        reason: `Skipping: none of the ${files.length} files changed ${since} is one of ${what}.`,
      };
    }
    const more = changed.length > LISTED ? [`  and ${changed.length - LISTED} more`] : [];
    return {
      deploy: true,
      reason: [
        `Deploying: ${changed.length} of ${what} changed ${since}:`,
        ...changed.slice(0, LISTED).map((file) => `  ${file}`),
        ...more,
      ].join('\n'),
    };
  } catch (error) {
    return deployAnyway(error.message);
  }
}

/**
 * Fetches the commits from GitHub into a throwaway repository and lists the files that differ
 * between the base and the head. Only commits are downloaded; git fetches the folder listings the
 * comparison reads as it reads them, and no file's contents.
 *
 * @param {Comparison} comparison
 * @returns {{ base: string, files: string[] }}
 */
export function changesOnGitHub({ repo, head, base }) {
  const folder = mkdtempSync(join(tmpdir(), 'consola-vercel-ignore-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: folder,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '0' },
    });
  const fetch = (...args) =>
    git('fetch', '--quiet', '--no-tags', '--filter=tree:0', 'origin', ...args);
  try {
    git('init', '--quiet');
    git('remote', 'add', 'origin', repo);
    let baseSha;
    if ('sha' in base) {
      fetch('--depth=1', head, base.sha);
      baseSha = base.sha;
    } else {
      // Both histories, to find where the branch left: commits only, under a megabyte.
      fetch(head, `refs/heads/${base.branch}:refs/base`);
      baseSha = git('merge-base', 'refs/base', head).trim();
    }
    const files = git('diff', '--no-renames', '--no-ext-diff', '--name-only', '-z', baseSha, head)
      .split('\0')
      .filter(Boolean);
    return { base: baseSha, files };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] === import.meta.filename;
if (invokedDirectly) {
  const root = dirname(import.meta.dirname);
  const { deploy, reason } = decide({
    env: process.env,
    readVercelignore: () => readFileSync(join(root, '.vercelignore'), 'utf8'),
    changes: changesOnGitHub,
  });
  console.log(reason);
  process.exit(deploy ? 1 : 0);
}
