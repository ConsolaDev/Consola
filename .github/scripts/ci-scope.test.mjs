import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scope } from './ci-scope.mjs';

const all = [
  '@consola/automation-engine',
  '@consola/cloud-api',
  '@consola/cloud-region',
  '@consola/cloud-web',
  '@consola/factory-spec',
  '@consola/website',
  'consola',
];
const everything = {
  desktop: true,
  website: true,
  packages: [
    '@consola/automation-engine',
    '@consola/cloud-api',
    '@consola/cloud-region',
    '@consola/cloud-web',
    '@consola/factory-spec',
  ],
};
const pr = (changedFiles, affected = []) =>
  scope({ event: 'pull_request', changedFiles, affected, all });
const checks = ({ desktop, website, packages }) => ({ desktop, website, packages });

test('a push to main checks everything', () => {
  assert.deepEqual(
    checks(scope({ event: 'push', changedFiles: [], affected: [], all })),
    everything,
  );
});

test('a change to one cloud app checks that app alone, not the desktop', () => {
  assert.deepEqual(checks(pr(['apps/cloud-region/src/main.ts'], ['@consola/cloud-region'])), {
    desktop: false,
    website: false,
    packages: ['@consola/cloud-region'],
  });
});

test('a change to the desktop checks the website too, whose demo is its renderer', () => {
  assert.deepEqual(checks(pr(['apps/desktop/src/shared/constants.ts'], ['consola'])), {
    desktop: true,
    website: true,
    packages: [],
  });
});

test('a change to a shared package checks the packages that depend on it', () => {
  assert.deepEqual(
    checks(
      pr(
        ['packages/factory-spec/src/index.ts'],
        ['@consola/automation-engine', '@consola/factory-spec', 'consola'],
      ),
    ),
    {
      desktop: true,
      website: true,
      packages: ['@consola/automation-engine', '@consola/factory-spec'],
    },
  );
});

test('a change to what every check depends on checks everything', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.github/scripts/ci-scope.mjs',
    'package.json',
    'pnpm-workspace.yaml',
    'patches/@xterm__xterm@6.0.0.patch',
    'turbo.json',
  ]) {
    assert.deepEqual(checks(pr([file])), everything, file);
  }
});

test("a package's own package.json is left to Turborepo", () => {
  assert.deepEqual(checks(pr(['apps/cloud-web/package.json'], ['@consola/cloud-web'])), {
    desktop: false,
    website: false,
    packages: ['@consola/cloud-web'],
  });
});

test("the website's deploy settings check the website", () => {
  assert.deepEqual(checks(pr(['vercel.json'])), { desktop: false, website: true, packages: [] });
});

test('a change to no package checks no package', () => {
  const result = pr(['README.md', 'AGENTS.md', '.github/workflows/cla.yml']);
  assert.deepEqual(checks(result), { desktop: false, website: false, packages: [] });
  assert.equal(result.reason, 'This change affects no package.');
});
