import { describe, expect, it } from 'vitest';
import type {
  ProviderPausing,
  ProviderSandbox,
  ProviderSnapshots,
  SandboxProvider,
} from './application/ports';
import { ContractFailure } from './contract/expect';
import { type ContractSubject, sandboxContract } from './contract/sandboxContract';
import { SANDBOX_CAPABILITIES } from './domain/capabilities';
import { SandboxError } from './domain/errors';
import { FakeProvider, type FakeProviderOptions } from './providers/fake/FakeProvider';
import { POSIX_PROGRAMS } from './providers/fake/posixPrograms';

/**
 * The contract, run against every provider: one test per check, and a check about a capability
 * the provider lacks is skipped. A real provider joins `PROVIDERS` behind the variable that says
 * its credentials are present, so a run without them skips it (`AGENTS.md`).
 */

interface ProviderUnderTest {
  readonly name: string;
  /** A fresh subject for each check, so no check sees another's sandboxes. */
  readonly subject: () => ContractSubject;
  /** Why the provider is skipped in this run, or null when it runs. */
  readonly skipped: string | null;
}

const fake = (options: FakeProviderOptions = {}): FakeProvider =>
  new FakeProvider({ programs: POSIX_PROGRAMS, ...options });

const PROVIDERS: readonly ProviderUnderTest[] = [
  {
    name: 'the fake provider, with the basics only',
    subject: () => ({ provider: fake(), template: 'base' }),
    skipped: null,
  },
  {
    name: 'the fake provider, with every capability',
    subject: () => ({ provider: fake({ capabilities: SANDBOX_CAPABILITIES }), template: 'base' }),
    skipped: null,
  },
];

for (const { name, subject, skipped } of PROVIDERS) {
  describe.skipIf(skipped !== null)(`${name} keeps the contract: it`, () => {
    const { provider } = subject();
    for (const check of sandboxContract) {
      const lacks = check.needs !== undefined && provider[check.needs] === undefined;
      it.skipIf(lacks)(check.name, () => check.run(subject()));
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

/** The fake with each of its sandboxes changed by `change`, the way a faulty provider would be. */
function broken(
  change: (inner: ProviderSandbox) => Partial<ProviderSandbox>,
  options: FakeProviderOptions = {},
): SandboxProvider {
  const provider = fake(options);
  return {
    create: async (createOptions) => {
      const inner = await provider.create(createOptions);
      return { ...inner, ...change(inner) };
    },
    pausing: provider.pausing,
  };
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
    provider: () => SandboxProvider;
    check: string;
    error: typeof ContractFailure | typeof SandboxError;
  }> = [
    {
      does: 'creates a sandbox from a template it does not have',
      provider: () => {
        const inner = fake();
        return { create: (options) => inner.create({ ...options, template: 'base' }) };
      },
      check: 'refuses a template it does not have',
      error: ContractFailure,
    },
    {
      does: 'keeps every sandbox in one filesystem',
      provider: () =>
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
      provider: () =>
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
      provider: () =>
        broken((inner) => ({
          start: (command) =>
            inner.start({ ...command, argv: command.argv.join(' ').split(/\s+/) }),
        })),
      check: 'hands each argument to the program as it is',
      error: ContractFailure,
    },
    {
      does: "drops a command's own variables",
      provider: () =>
        broken((inner) => ({ start: (command) => inner.start({ ...command, env: undefined }) })),
      check: "gives every command the sandbox's variables",
      error: ContractFailure,
    },
    {
      does: 'delivers output only after the command has ended',
      provider: () =>
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
      provider: () =>
        broken((inner) => ({
          readFile: (path) => inner.readFile(path).catch(() => new Uint8Array()),
        })),
      check: 'refuses to read a file that is not there',
      error: ContractFailure,
    },
    {
      does: 'exposes every port at one address',
      provider: () => broken(() => ({ exposePort: async () => 'https://one.fake-sandbox.test' })),
      check: 'exposes each port at an address of its own',
      error: ContractFailure,
    },
    {
      does: 'still takes work once stopped',
      provider: () => broken(() => ({ stop: async () => undefined })),
      check: 'stops once however often asked',
      error: ContractFailure,
    },
    {
      does: 'loses files over a pause',
      provider: () => {
        const inner = fake({ capabilities: ['pausing'] });
        const pausing = inner.pausing as ProviderPausing;
        return {
          create: (options) => inner.create(options),
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
      check: 'pauses a sandbox, and resumes it',
      error: SandboxError,
    },
    {
      does: 'keeps a snapshot it was asked to remove',
      provider: () => {
        const inner = fake({ capabilities: ['snapshots'] });
        const snapshots = inner.snapshots as ProviderSnapshots;
        return {
          create: (options) => inner.create(options),
          snapshots: { snapshot: (id) => snapshots.snapshot(id), remove: async () => undefined },
        };
      },
      check: 'removes a snapshot, which no sandbox then starts from',
      error: ContractFailure,
    },
  ];

  it.each(cases)('$does', async ({ provider, check, error }) => {
    await expect(checkNamed(check).run({ provider: provider(), template: 'base' })).rejects.toThrow(
      error,
    );
  });
});
