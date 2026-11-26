// Decides what CI checks: which packages a pull request can break, and so
// which of ci.yml's jobs run. Writes the answer to the step's outputs and to
// the run's summary.
//
// Turborepo answers most of it. `turbo ls --affected` lists the packages a
// change touches and every package that depends on them, read from the
// workspace graph and, for dependency changes, the lockfile. The rules below
// cover what that graph cannot see.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * Files every package's install or checks depend on. A change to one checks
 * everything. An entry ending in `/` is a folder.
 */
export const CHECKS_EVERYTHING = [
  '.github/workflows/ci.yml',
  '.github/actions/',
  '.github/scripts/',
  'package.json',
  'pnpm-workspace.yaml',
  'patches/',
  'turbo.json',
];

const DESKTOP = 'consola';
const WEBSITE = '@consola/website';
const AGENT_UI = '@consola/agent-ui';
const CLOUD_API = '@consola/cloud-api';
const CLOUD_WEB = '@consola/cloud-web';

/**
 * The folder of the copied t3code packages (vendor/t3code/UPSTREAM.md). They
 * are checked with their own scripts in one job, `vendor`, never one job each.
 */
const VENDORED = 'vendor/';

/**
 * Files only the website's deploy reads, which belong to no package.
 */
const WEBSITE_DEPLOY = new Set(['vercel.json', '.vercelignore']);

/**
 * Files of other apps the chat view's page tests read at test time
 * (packages/agent-ui/src/testing/embeddingPages.ts): the desktop's tokens and
 * global.css, and cloud-web's own CSS (its session page's included) and the
 * Radix Themes stylesheet in its node_modules, which its package.json (or the
 * lockfile, within its range) decides. ci-scope.test.mjs checks every file that
 * module reads is here.
 */
const AGENT_UI_READS = new Set([
  'apps/desktop/src/renderer/styles/global.css',
  'apps/desktop/src/renderer/styles/themes/tokens.css',
  'apps/desktop/src/renderer/styles/themes/light.css',
  'apps/cloud-web/src/ui/styles.css',
  'apps/cloud-web/src/ui/Sessions.css',
  'apps/cloud-web/package.json',
]);
const LOCKFILE = 'pnpm-lock.yaml';

const matches = (file, pattern) =>
  pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern;

/**
 * @param {{ event: string, changedFiles: string[], affected: string[], all: string[], vendored?: string[] }} change
 *   `affected` is what `turbo ls --affected` reported, `all` every package,
 *   `vendored` the packages under `vendor/`.
 * @returns {{ reason: string, desktop: boolean, website: boolean, agentUi: boolean, vendor: boolean, packages: string[] }}
 *   `packages` holds every package to check other than the desktop, the
 *   website, the chat view and the vendored packages, which have jobs of their
 *   own.
 */
export function scope({ event, changedFiles, affected, all, vendored = [] }) {
  if (event !== 'pull_request') {
    return plan(all, vendored, `A ${event} event checks everything.`);
  }
  const trigger = changedFiles.find((file) => CHECKS_EVERYTHING.some((p) => matches(file, p)));
  if (trigger) {
    return plan(all, vendored, `\`${trigger}\` changed, and every package's checks depend on it.`);
  }
  const packages = new Set(affected);
  // The website's demo is the desktop's renderer, imported by path. Its
  // package.json cannot declare that: Vercel uploads the site without
  // `packages/` (`.vercelignore`), so a workspace dependency would not install.
  if (packages.has(DESKTOP)) packages.add(WEBSITE);
  // The web app's API types are generated from cloud-api's openapi.json, read as a file: no app
  // imports another, so the graph cannot say the web app depends on the API.
  if (packages.has(CLOUD_API)) packages.add(CLOUD_WEB);
  if (changedFiles.some((file) => WEBSITE_DEPLOY.has(file))) packages.add(WEBSITE);
  // The chat view's page tests read the desktop's and cloud-web's CSS as
  // files, and cloud-web's Radix Themes from its node_modules: a change to
  // one, or a lockfile change to what cloud-web installs, can break them.
  if (
    changedFiles.some((file) => AGENT_UI_READS.has(file)) ||
    (changedFiles.includes(LOCKFILE) && packages.has(CLOUD_WEB))
  ) {
    packages.add(AGENT_UI);
  }
  return plan(
    [...packages],
    vendored,
    packages.size > 0
      ? 'These are the packages this change affects, and the packages that depend on them.'
      : 'This change affects no package.',
  );
}

function plan(packages, vendored, reason) {
  const set = new Set(packages);
  const isVendored = new Set(vendored);
  const ownJob = new Set([DESKTOP, WEBSITE, AGENT_UI]);
  return {
    reason,
    desktop: set.has(DESKTOP),
    website: set.has(WEBSITE),
    agentUi: set.has(AGENT_UI),
    vendor: [...set].some((name) => isVendored.has(name)),
    packages: [...set].filter((name) => !ownJob.has(name) && !isVendored.has(name)).sort(),
  };
}

const run = (command, args, env = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const packageItems = (turboJson) => JSON.parse(turboJson).packages.items;
const packageNames = (turboJson) => packageItems(turboJson).map((item) => item.name);

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? 'local';
  const items = packageItems(run('pnpm', ['exec', 'turbo', 'ls', '--output=json']));
  const all = items.map((item) => item.name);
  const vendored = items.filter((item) => item.path.startsWith(VENDORED)).map((item) => item.name);
  let changedFiles = [];
  let affected = [];
  if (event === 'pull_request') {
    // actions/checkout puts a pull request on its merge commit, whose first
    // parent is the commit of the base branch it merges into.
    const base = run('git', ['rev-parse', 'HEAD^1']).trim();
    changedFiles = run('git', ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
    affected = packageNames(
      run('pnpm', ['exec', 'turbo', 'ls', '--affected', '--output=json'], {
        TURBO_SCM_BASE: base,
        TURBO_SCM_HEAD: 'HEAD',
      }),
    );
  }

  const result = scope({ event, changedFiles, affected, all, vendored });
  const lines = [
    `desktop=${result.desktop}`,
    `website=${result.website}`,
    `agent-ui=${result.agentUi}`,
    `vendor=${result.vendor}`,
    `packages=${JSON.stringify(result.packages)}`,
  ];
  console.log(result.reason);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const yesNo = (value) => (value ? 'runs' : 'skipped');
    const list = result.packages.map((name) => `\`${name}\``).join(', ') || 'none';
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '### What this run checks',
        '',
        result.reason,
        '',
        '| Job | |',
        '| --- | --- |',
        `| Desktop and Desktop E2E | ${yesNo(result.desktop)} |`,
        `| Website | ${yesNo(result.website)} |`,
        `| Agent UI | ${yesNo(result.agentUi)} |`,
        `| Vendored t3code | ${yesNo(result.vendor)} |`,
        `| Packages | ${list} |`,
        '',
      ].join('\n'),
    );
  }
}

if (import.meta.main) main();
