import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ProviderPausing,
  ProviderSandbox,
  ProviderSnapshots,
  SandboxProvider,
} from './application/ports';
import { ContractFailure } from './contract/expect';
import { sandboxContract } from './contract/sandboxContract';
import type { ContractSubject } from './contract/sandboxContract';
import { SANDBOX_CAPABILITIES } from './domain/capabilities';
import { SandboxError } from './domain/errors';
import { E2BProvider } from './providers/e2b/E2BProvider';
import { FakeProvider } from './providers/fake/FakeProvider';
import type { FakeProviderOptions } from './providers/fake/FakeProvider';
import { POSIX_PROGRAMS } from './providers/fake/posixPrograms';

/**
 * The contract, run against every provider: one test per check, and a check about a capability
 * the provider lacks is skipped. A real provider joins `PROVIDERS` behind the variable that says
 * its credentials are present, so a run without them skips it, and says so (`AGENTS.md`).
 */

interface ProviderUnderTest {
  readonly name: string;
  /** A fresh subject for each check, so no check sees another's sandboxes. */
  readonly subject: () => ContractSubject;
  /** Why the provider is skipped in this run, or null when it runs. */
  readonly skipped: string | null;
  /** How long one check may take, in milliseconds, when not Vitest's default. */
  readonly timeoutMs?: number;
}

const fake = (options: FakeProviderOptions = {}): FakeProvider =>
  new FakeProvider({ programs: POSIX_PROGRAMS, ...options });

/** A subject for `provider`, built over `clock`, whose time passes when the fake's does. */
const over = (clock: FakeProvider, provider: SandboxProvider = clock): ContractSubject => ({
  provider,
  template: 'base',
  elapse: async (seconds) => clock.elapse(seconds),
});

// The key lives in packages/sandbox/.env (see .env.example), which CI does not have.
const ENV_FILE = join(__dirname, '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const E2B_API_KEY = process.env.E2B_API_KEY?.trim() ?? '';

const PROVIDERS: readonly ProviderUnderTest[] = [
  {
    name: 'the fake provider, with the basics only',
    subject: () => over(fake()),
    skipped: null,
  },
  {
    name: 'the fake provider, with every capability',
    subject: () => over(fake({ capabilities: SANDBOX_CAPABILITIES })),
    skipped: null,
  },
  {
    name: 'the E2B provider, on real sandboxes',
    // E2B's own public template, which has every program the contract runs.
    subject: () => ({
      provider: new E2BProvider({ apiKey: E2B_API_KEY }),
      template: 'base',
      elapse: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    }),
    skipped:
      E2B_API_KEY === ''
        ? 'E2B_API_KEY is not set, in packages/sandbox/.env or the environment, so no real E2B sandbox was started'
        : null,
    // A check starts up to two sandboxes, and the lifetime checks wait out a lifetime.
    timeoutMs: 120_000,
  },
];

for (const { name, subject, skipped, timeoutMs } of PROVIDERS) {
  if (skipped !== null) {
    // Said out loud, so a run without credentials never reads as the provider having passed.
    process.stderr.write(`Skipped ${name}: ${skipped}.\n`);
    describe.skip(`${name} keeps the contract (skipped: ${skipped}): it`, () => {
      for (const check of sandboxContract) it(check.name, () => undefined);
    });
    continue;
  }
  describe(`${name} keeps the contract: it`, () => {
    const { provider } = subject();
    for (const check of sandboxContract) {
      const lacks = check.needs !== undefined && provider[check.needs] === undefined;
      it.skipIf(lacks)(check.name, () => check.run(subject()), timeoutMs);
    }
  });
}

describe('the contract', () => {
  it('names each check once, and only capabilities that exist', () => {
    const names = sandboxContract.map((check) => check.name);
    expect(new Set(names).size).toBe(names.length);
    for (const check of sandboxContract) {
      if (check.needs !== undefined) expect(SANDBOX_CAPABILITIES).toContain(check.needs);
    }
  });

  it('checks every capability', () => {
    const covered = new Set(sandboxContract.map((check) => check.needs));
    for (const capability of SANDBOX_CAPABILITIES) expect(covered).toContain(capability);
  });
});

/** The fake's members as a provider of plain functions, for a case to replace some of. */
const membersOf = (inner: FakeProvider): SandboxProvider => ({
  create: (options) => inner.create(options),
  attach: (sandboxId) => inner.attach(sandboxId),
  stop: (sandboxId) => inner.stop(sandboxId),
  ...(inner.pausing && { pausing: inner.pausing }),
  ...(inner.snapshots && { snapshots: inner.snapshots }),
  ...(inner.keepAlive && { keepAlive: inner.keepAlive }),
});

/** The fake with each of its sandboxes changed by `change`, the way a faulty provider would be. */
function broken(
  change: (inner: ProviderSandbox) => Partial<ProviderSandbox>,
  options: FakeProviderOptions = {},
): ContractSubject {
  const inner = fake(options);
  const changed = (sandbox: ProviderSandbox): ProviderSandbox => ({
    ...sandbox,
    ...change(sandbox),
  });
  return over(inner, {
    ...membersOf(inner),
    create: async (createOptions) => changed(await inner.create(createOptions)),
    attach: async (sandboxId) => changed(await inner.attach(sandboxId)),
  });
}

/** The fake with some of its members replaced by `replace`. */
function brokenMembers(
  replace: (inner: FakeProvider) => Partial<SandboxProvider>,
  options: FakeProviderOptions = {},
): ContractSubject {
  const inner = fake(options);
  return over(inner, { ...membersOf(inner), ...replace(inner) });
}

const checkNamed = (name: string) => {
  const check = sandboxContract.find((candidate) => candidate.name.startsWith(name));
  if (!check) throw new Error(`No contract check starts with "${name}".`);
  return check;
};

describe('the contract fails a provider that', () => {
  const store = new Map<string, Uint8Array>();
  const cases: ReadonlyArray<{
    does: string;
    subject: () => ContractSubject;
    check: string;
    error: typeof ContractFailure | typeof SandboxError;
  }> = [
    {
      does: 'creates a sandbox from a template it does not have',
      subject: () =>
        brokenMembers((inner) => ({
          create: (options) => inner.create({ ...options, template: 'base' }),
        })),
      check: 'refuses a template it does not have',
      error: ContractFailure,
    },
    {
      does: 'keeps every sandbox in one filesystem',
      subject: () =>
        broken(() => ({
          readFile: async (path) => {
            const content = store.get(path);
            if (!content) throw new SandboxError('not-found', `No ${path}.`);
            return content;
          },
          writeFile: async (path, content) => {
            store.set(path, content);
          },
        })),
      check: "keeps each sandbox's files to itself",
      error: ContractFailure,
    },
    {
      does: 'rejects a command that exits non-zero',
      subject: () =>
        broken((inner) => ({
          start: async (command) => {
            const started = await inner.start(command);
            return {
              ...started,
              wait: async () => {
                const code = await started.wait();
                if (code !== 0) throw new Error(`exited with ${code}`);
                return code;
              },
            };
          },
        })),
      check: 'reports a failing exit code as a result',
      error: SandboxError,
    },
    {
      does: 'passes arguments through a shell that splits them',
      subject: () =>
        broken((inner) => ({
          start: (command) =>
            inner.start({ ...command, argv: command.argv.join(' ').split(/\s+/) }),
        })),
      check: 'hands each argument to the program as it is',
      error: ContractFailure,
    },
    {
      does: "drops a command's own variables",
      subject: () =>
        broken((inner) => ({ start: (command) => inner.start({ ...command, env: undefined }) })),
      check: "gives every command the sandbox's variables",
      error: ContractFailure,
    },
    {
      does: 'delivers output only after the command has ended',
      subject: () =>
        broken((inner) => ({
          start: async (command) => {
            const held: string[] = [];
            const started = await inner.start({
              ...command,
              onStdout: (chunk) => held.push(chunk),
            });
            return {
              ...started,
              wait: async () => {
                const code = await started.wait();
                // As output still in flight over a network would.
                setTimeout(() => {
                  for (const chunk of held) command.onStdout?.(chunk);
                }, 0);
                return code;
              },
            };
          },
        })),
      check: 'streams output to the listeners, all of it before the result',
      error: ContractFailure,
    },
    {
      does: 'reads a missing file as an empty one',
      subject: () =>
        broken((inner) => ({
          readFile: (path) => inner.readFile(path).catch(() => new Uint8Array()),
        })),
      check: 'refuses to read a file that is not there',
      error: ContractFailure,
    },
    {
      does: 'exposes every port at one address',
      subject: () => broken(() => ({ exposePort: async () => 'https://one.fake-sandbox.test' })),
      check: 'exposes each port at an address of its own',
      error: ContractFailure,
    },
    {
      does: 'still takes work once stopped',
      subject: () => broken(() => ({ stop: async () => undefined })),
      check: 'stops once however often asked',
      error: ContractFailure,
    },
    {
      does: 'lets a sandbox outlive its lifetime',
      subject: () =>
        brokenMembers((inner) => ({
          create: ({ lifetimeSeconds: _ignored, ...options }) => inner.create(options),
        })),
      check: 'stops a sandbox on its own once its lifetime runs out',
      error: ContractFailure,
    },
    {
      does: "lengthens a sandbox's life when attaching to it",
      subject: () =>
        brokenMembers(
          (inner) => ({
            attach: async (sandboxId) => {
              const attached = await inner.attach(sandboxId);
              await inner.keepAlive?.renew(sandboxId, 300);
              return attached;
            },
          }),
          { capabilities: ['keepAlive'] },
        ),
      check: 'attaches to a running sandbox by its id',
      error: ContractFailure,
    },
    {
      does: 'attaches to a sandbox that is not there',
      subject: () =>
        brokenMembers((inner) => ({
          attach: async (sandboxId) => ({
            ...(await inner.create({ template: 'base' })),
            id: sandboxId,
          }),
        })),
      check: 'refuses to attach to a sandbox that is not there',
      error: ContractFailure,
    },
    {
      does: 'leaves a sandbox running when asked to stop it by its id',
      subject: () => brokenMembers(() => ({ stop: async () => undefined })),
      check: 'stops a sandbox by its id',
      error: ContractFailure,
    },
    {
      does: 'loses files over a pause',
      subject: () =>
        brokenMembers(
          (inner) => {
            const pausing = inner.pausing as ProviderPausing;
            return {
              pausing: {
                pause: (id) => pausing.pause(id),
                resume: async (id) => ({
                  ...(await pausing.resume(id)),
                  readFile: async (path) => {
                    throw new SandboxError('not-found', `No ${path}.`);
                  },
                }),
              },
            };
          },
          { capabilities: ['pausing'] },
        ),
      check: 'pauses a sandbox, and resumes it',
      error: SandboxError,
    },
    {
      does: 'keeps a snapshot it was asked to remove',
      subject: () =>
        brokenMembers(
          (inner) => {
            const snapshots = inner.snapshots as ProviderSnapshots;
            return {
              snapshots: {
                snapshot: (id) => snapshots.snapshot(id),
                remove: async () => undefined,
              },
            };
          },
          { capabilities: ['snapshots'] },
        ),
      check: 'removes a snapshot, which no sandbox then starts from',
      error: ContractFailure,
    },
    {
      does: 'renews nothing',
      subject: () =>
        brokenMembers(() => ({ keepAlive: { renew: async () => undefined } }), {
          capabilities: ['keepAlive'],
        }),
      check: "renews a sandbox's lifetime",
      error: SandboxError,
    },
    {
      does: 'only ever lengthens a lifetime it renews',
      subject: () =>
        brokenMembers(
          (inner) => ({
            keepAlive: {
              renew: async (id, seconds) => {
                const remaining = inner.sandboxes.find((s) => s.id === id)?.remainingSeconds;
                if (remaining == null || seconds > remaining) {
                  await inner.keepAlive?.renew(id, seconds);
                }
              },
            },
          }),
          { capabilities: ['keepAlive'] },
        ),
      check: "renews a sandbox's lifetime",
      error: ContractFailure,
    },
  ];

  it.each(cases)('$does', async ({ subject, check, error }) => {
    await expect(checkNamed(check).run(subject())).rejects.toThrow(error);
  });
});
