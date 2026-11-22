import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { comparisonFor, decide, inputsOf, previewInputsOf } from './vercel-ignore.mjs';

const vercelignore = readFileSync(new URL('../.vercelignore', import.meta.url), 'utf8');

const github = {
  VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_OWNER: 'ConsolaDev',
  VERCEL_GIT_REPO_SLUG: 'Consola',
  VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
  VERCEL_GIT_PREVIOUS_SHA: 'a'.repeat(40),
};
const preview = { ...github, VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'some-branch' };
const production = { ...github, VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };

const pushing = (env, files, base = 'a'.repeat(40)) =>
  decide({ env, readVercelignore: () => vercelignore, changes: () => ({ base, files }) });

const desktopOnly = [
  'apps/cloud-global/src/app.ts',
  'apps/desktop/src/main/index.ts',
  'apps/desktop/src/renderer/App.tsx',
  'pnpm-lock.yaml',
];

test('the inputs are the leaves of the allow-list, not the folders that open the way', () => {
  assert.deepEqual(
    inputsOf(
      ['*', '!apps', '!apps/web', '!apps/web/src', '!apps/web/src/**', '!a.json'].join('\n'),
    ),
    ['a.json', 'apps/web/src'],
  );
});

test('the real .vercelignore names the website, the renderer it bundles and this script', () => {
  const inputs = inputsOf(vercelignore);
  for (const input of [
    '.vercelignore',
    'vercel.json',
    'pnpm-lock.yaml',
    'patches',
    'apps/website/src',
    'apps/website/demo',
    'apps/desktop/src/renderer',
    'apps/desktop/src/shared',
    'tools/vercel-ignore.mjs',
  ]) {
    assert.ok(inputs.includes(input), `${input} is an input`);
  }
  assert.ok(!inputs.includes('apps'));
  assert.ok(!inputs.includes('apps/desktop/src'));
});

test("a preview's inputs are the website's uploaded files and the deployment's configuration", () => {
  const inputs = previewInputsOf(inputsOf(vercelignore));
  assert.ok(inputs.includes('apps/website/src'));
  assert.ok(inputs.includes('vercel.json'));
  assert.ok(inputs.includes('tools/vercel-ignore.mjs'));
  assert.ok(!inputs.includes('apps/desktop/src/renderer'));
  assert.ok(!inputs.includes('pnpm-lock.yaml'));
});

test('a .vercelignore that is not a plain allow-list is refused', () => {
  assert.throws(() => inputsOf('node_modules\n!apps'), /allow-list/);
  assert.throws(() => inputsOf('*\n!apps/*.json'), /cannot read/);
  assert.throws(() => inputsOf('*\ndist'), /cannot read/);
  assert.throws(() => inputsOf('*\n!/apps'), /cannot read/);
});

test('comments, blank lines and a trailing slash are read', () => {
  assert.deepEqual(inputsOf('# note\n*\n\n!patches/\n!patches/**\n'), ['patches']);
});

test('a preview skips a change to the desktop, and production deploys it', () => {
  const skipped = pushing(preview, desktopOnly);
  assert.equal(skipped.deploy, false);
  assert.match(skipped.reason, /none of the 4 files/);
  const deployed = pushing(production, desktopOnly);
  assert.equal(deployed.deploy, true);
  assert.match(deployed.reason, /apps\/desktop\/src\/renderer\/App\.tsx/);
  assert.doesNotMatch(deployed.reason, /cloud-global|src\/main/);
});

test("a preview deploys for the website's own files, and names them", () => {
  const { deploy, reason } = pushing(preview, [...desktopOnly, 'apps/website/src/main.tsx']);
  assert.equal(deploy, true);
  assert.match(reason, /apps\/website\/src\/main\.tsx/);
  assert.doesNotMatch(reason, /renderer/);
  assert.equal(pushing(preview, ['vercel.json']).deploy, true);
});

test('neither deploys for a change to nothing the site uploads', () => {
  const files = ['apps/website/tests/home.spec.ts', 'apps/website/README.md', 'AGENTS.md'];
  assert.equal(pushing(preview, files).deploy, false);
  assert.equal(pushing(production, files).deploy, false);
});

test('a file that only shares an input’s prefix is not an input', () => {
  assert.equal(pushing(production, ['apps/website-old/x.ts', 'vercel.json.bak']).deploy, false);
});

test('a long list is cut short in the log', () => {
  const files = Array.from({ length: 25 }, (_, i) => `apps/website/src/f${i}.ts`);
  assert.match(pushing(preview, files).reason, /and 5 more/);
});

test('a redeploy of the commit compared with deploys', () => {
  assert.equal(pushing(preview, [], github.VERCEL_GIT_COMMIT_SHA).deploy, true);
});

test('a branch with no commit of its own gets no preview, while main still deploys', () => {
  const { VERCEL_GIT_PREVIOUS_SHA: _p, ...firstPreview } = preview;
  const { VERCEL_GIT_PREVIOUS_SHA: _m, ...firstProduction } = production;
  const head = github.VERCEL_GIT_COMMIT_SHA;
  const skipped = pushing(firstPreview, [], head);
  assert.equal(skipped.deploy, false);
  assert.match(skipped.reason, /nothing of its own/);
  assert.equal(pushing(firstProduction, [], head).deploy, true);
});

test('a branch with no deployment yet compares with where it left main', () => {
  const { VERCEL_GIT_PREVIOUS_SHA: _, ...first } = preview;
  assert.deepEqual(comparisonFor(first).base, {
    branch: 'main',
    name: 'where this branch left main',
  });
  assert.equal(comparisonFor(preview).base.sha, 'a'.repeat(40));
  assert.equal(comparisonFor(preview).repo, 'https://github.com/ConsolaDev/Consola.git');
});

test('main is production even when Vercel does not say so', () => {
  assert.equal(comparisonFor({ ...github, VERCEL_GIT_COMMIT_REF: 'main' }).production, true);
  assert.equal(comparisonFor({ ...github, VERCEL_ENV: 'production' }).production, true);
  assert.equal(comparisonFor(preview).production, false);
});

test('whatever cannot be answered deploys', () => {
  const failing = decide({
    env: preview,
    readVercelignore: () => vercelignore,
    changes: () => {
      throw new Error('fatal: remote error');
    },
  });
  assert.equal(failing.deploy, true);
  assert.match(failing.reason, /remote error/);
  assert.equal(pushing({}, []).deploy, true);
  assert.equal(pushing({ ...preview, VERCEL_GIT_PROVIDER: 'gitlab' }, []).deploy, true);
  const unreadable = decide({
    env: preview,
    readVercelignore: () => 'dist\n',
    changes: () => ({ base: 'a'.repeat(40), files: [] }),
  });
  assert.equal(unreadable.deploy, true);
});
