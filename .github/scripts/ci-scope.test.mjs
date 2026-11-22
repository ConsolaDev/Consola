import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scope } from './ci-scope.mjs';

const all = [
  '@consola/automation-engine',
  '@consola/cloud-global',
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
    '@consola/cloud-global',
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

// The chat view and the copied t3code packages (vendor/t3code), which have
// jobs of their own.
const vendored = ['@t3tools/contracts', 't3'];
const withOwnJobs = [...all, '@consola/agent-ui', '@consola/host', ...vendored];
const jobs = ({ agentUi, vendor, packages }) => ({ agentUi, vendor, packages });

test('a push checks the chat view and the vendored packages in their own jobs', () => {
  assert.deepEqual(
    jobs(scope({ event: 'push', changedFiles: [], affected: [], all: withOwnJobs, vendored })),
    { agentUi: true, vendor: true, packages: [...everything.packages, '@consola/host'].sort() },
  );
});

test('a change to a vendored package runs the vendor job, never one job per copied package', () => {
  const result = scope({
    event: 'pull_request',
    changedFiles: ['vendor/t3code/packages/contracts/src/index.ts'],
    affected: ['@consola/agent-ui', '@consola/host', '@t3tools/contracts', 't3'],
    all: withOwnJobs,
    vendored,
  });
  assert.deepEqual(jobs(result), { agentUi: true, vendor: true, packages: ['@consola/host'] });
});

test('a change to the chat view alone runs its job and nothing vendored', () => {
  const result = scope({
    event: 'pull_request',
    changedFiles: ['packages/agent-ui/src/AgentChat.tsx'],
    affected: ['@consola/agent-ui'],
    all: withOwnJobs,
    vendored,
  });
  assert.deepEqual(jobs(result), { agentUi: true, vendor: false, packages: [] });
});
