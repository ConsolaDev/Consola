import { describe, expect, it } from 'vitest';
import { SandboxError } from '../domain/errors';
import type { Command } from '../domain/sandbox';
import { FakeProvider } from '../providers/fake/FakeProvider';
import { POSIX_PROGRAMS } from '../providers/fake/posixPrograms';
import type { ProviderCommand, ProviderSandbox, SandboxProvider } from './ports';
import { requireCapability, sandboxesFrom } from './sandboxes';
import type { Sandbox } from './sandboxes';

/** A provider that records every call it gets, and answers as `overrides` say. */
function spy(
  overrides: Partial<ProviderSandbox> = {},
  provider: Partial<SandboxProvider> = {},
  command: Partial<ProviderCommand> = {},
) {
  const calls: string[] = [];
  const sandbox: ProviderSandbox = {
    id: 'spy-1',
    start: async (started) => {
      calls.push(`start ${started.argv.join(' ')}`);
      return { wait: async () => 0, kill: async () => undefined, ...command };
    },
    readFile: async (path) => {
      calls.push(`readFile ${path}`);
      return new Uint8Array();
    },
    writeFile: async (path) => {
      calls.push(`writeFile ${path}`);
    },
    exposePort: async (port) => {
      calls.push(`exposePort ${port}`);
      return `https://${port}-spy-1.spy.test`;
    },
    stop: async () => {
      calls.push('stop');
    },
    ...overrides,
  };
  return {
    calls,
    sandboxes: sandboxesFrom({
      create: async (options) => {
        calls.push(
          `create ${options.template}${options.lifetimeSeconds ? ` for ${options.lifetimeSeconds}s` : ''}${options.publicPorts === undefined ? '' : ` publicPorts ${options.publicPorts}`}`,
        );
        return sandbox;
      },
      attach: async (sandboxId) => {
        calls.push(`attach ${sandboxId}`);
        return sandbox;
      },
      stop: async (sandboxId) => {
        calls.push(`stop ${sandboxId}`);
      },
      ...provider,
    }),
  };
}

/** A provider's members `sandboxesFrom` needs, answered by `sandbox`, for a test to add to. */
const basics = (sandbox: ProviderSandbox): SandboxProvider => ({
  create: async () => sandbox,
  attach: async () => sandbox,
  stop: async () => undefined,
});

const fakeSandboxes = (options: ConstructorParameters<typeof FakeProvider>[0] = {}) => {
  const fake = new FakeProvider({ programs: POSIX_PROGRAMS, ...options });
  return { fake, sandboxes: sandboxesFrom(fake) };
};

const coded = (code: SandboxError['code'], message?: RegExp) =>
  expect.objectContaining({ code, ...(message && { message: expect.stringMatching(message) }) });

describe('sandboxesFrom refuses a malformed request before the provider sees it', () => {
  it.each<[string, (sandbox: Sandbox) => Promise<unknown>]>([
    ['a command with no program', (sandbox) => sandbox.run({ argv: [] })],
    [
      'a command with a NUL in an argument',
      (sandbox) => sandbox.run({ argv: ['printf', '\u0000'] }),
    ],
    ['a command in a relative folder', (sandbox) => sandbox.run({ argv: ['pwd'], cwd: 'tmp' })],
    [
      'a command with a bad variable name',
      (sandbox) => sandbox.run({ argv: ['pwd'], env: { 'A-B': 'x' } }),
    ],
    ['reading a relative path', (sandbox) => sandbox.readFile('notes.txt')],
    ['writing a relative path', (sandbox) => sandbox.writeFile('notes.txt', 'x')],
    ['writing a number', (sandbox) => sandbox.writeFile('/tmp/n', 7 as never)],
    ['exposing port 0', (sandbox) => sandbox.exposePort(0)],
    ['exposing port 65536', (sandbox) => sandbox.exposePort(65536)],
    ['exposing port 80.5', (sandbox) => sandbox.exposePort(80.5)],
  ])('%s', async (_name, attempt) => {
    const { calls, sandboxes } = spy();
    const sandbox = await sandboxes.create({ template: 'base' });
    await expect(attempt(sandbox)).rejects.toEqual(coded('invalid'));
    expect(calls).toEqual(['create base']);
  });

  it.each([
    ['no template', { template: '' }],
    ['a bad variable name', { template: 'base', env: { '1X': 'a' } }],
  ])('creating with %s', async (_name, options) => {
    const { calls, sandboxes } = spy();
    await expect(sandboxes.create(options)).rejects.toEqual(coded('invalid'));
    await expect(sandboxes.withSandbox(options, async () => 1)).rejects.toEqual(coded('invalid'));
    expect(calls).toEqual([]);
  });

  it('passes copies, so a caller changing its request later changes nothing', async () => {
    const seen: Command[] = [];
    const { sandboxes } = spy({
      start: async (command) => {
        seen.push(command);
        return { wait: async () => 0, kill: async () => undefined };
      },
    });
    const sandbox = await sandboxes.create({ template: 'base' });
    const argv = ['printf', 'a'];
    const env = { A: '1' };
    await sandbox.run({ argv, env });
    argv.push('b');
    env.A = '2';
    expect(seen[0]).toMatchObject({ argv: ['printf', 'a'], env: { A: '1' } });
  });
});

describe('sandboxesFrom turns every failure into a SandboxError', () => {
  it("wraps what a provider throws as a provider error with the provider's message", async () => {
    const original = new Error('Template consola-session not found in this team');
    const { sandboxes } = spy(
      {},
      {
        create: async () => {
          throw original;
        },
      },
    );
    const error = await sandboxes.create({ template: 'consola-session' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: 'provider', message: original.message, cause: original });
  });

  it("keeps a provider's SandboxError and its code", async () => {
    const { sandboxes } = spy({
      readFile: async () => {
        throw new SandboxError('not-found', 'There is no file at /tmp/a.');
      },
    });
    const sandbox = await sandboxes.create({ template: 'base' });
    await expect(sandbox.readFile('/tmp/a')).rejects.toEqual(coded('not-found', /no file/));
  });

  it.each<[string, Parameters<typeof spy>]>([
    ['a sandbox with no id', [{ id: '' }]],
    ['an exit code below zero', [{}, {}, { wait: async () => -1 }]],
    ['an exit code that is not whole', [{}, {}, { wait: async () => 1.5 }]],
    ['a port address that is no URL', [{ exposePort: async () => '7420-spy.test' }]],
    ['a port address that is not http', [{ exposePort: async () => 'ftp://spy.test' }]],
    ['a file read as text', [{ readFile: async () => 'text' as never }]],
  ])('refuses %s from the provider', async (_name, args) => {
    const { sandboxes } = spy(...args);
    const attempt = async () => {
      const sandbox = await sandboxes.create({ template: 'base' });
      await sandbox.run({ argv: ['true'] });
      await sandbox.exposePort(7420);
      await sandbox.readFile('/tmp/a');
    };
    await expect(attempt()).rejects.toEqual(coded('provider'));
  });
});

describe('sandboxesFrom stops a sandbox whose answer it refuses', () => {
  it('for a create that gives no id', async () => {
    const { calls, sandboxes } = spy({ id: '' });
    await expect(sandboxes.create({ template: 'base' })).rejects.toEqual(coded('provider'));
    expect(calls).toEqual(['create base', 'stop']);
  });

  it('for a resume that gives back another sandbox', async () => {
    let stopped = 0;
    const other: ProviderSandbox = {
      id: 'spy-2',
      start: async () => ({ wait: async () => 0, kill: async () => undefined }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      exposePort: async () => 'https://spy.test',
      stop: async () => {
        stopped += 1;
      },
    };
    const sandboxes = sandboxesFrom({
      ...basics(other),
      pausing: { pause: async () => undefined, resume: async () => other },
    });
    await expect(requireCapability(sandboxes, 'pausing').resume('spy-1')).rejects.toEqual(
      coded('provider', /gave back sandbox spy-2/),
    );
    expect(stopped).toBe(1);
    await expect(sandboxes.attach('spy-1')).rejects.toEqual(
      coded('provider', /Attaching to spy-1 gave back sandbox spy-2/),
    );
    expect(stopped).toBe(2);
  });

  it('and still reports the refusal when that stop fails', async () => {
    const { sandboxes } = spy({
      id: '',
      stop: async () => {
        throw new Error('network down');
      },
    });
    await expect(sandboxes.create({ template: 'base' })).rejects.toEqual(
      coded('provider', /as a sandbox's id/),
    );
  });
});

describe('a sandbox from sandboxesFrom', () => {
  it('runs a command to its end, with its output and exit code', async () => {
    const { sandboxes } = fakeSandboxes();
    const sandbox = await sandboxes.create({ template: 'base' });
    expect(await sandbox.run({ argv: ['cat', '/tmp/none'] })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'cat: /tmp/none: No such file or directory\n',
    });
  });

  it('answers wait with the same result every time', async () => {
    const { sandboxes } = fakeSandboxes();
    const sandbox = await sandboxes.create({ template: 'base' });
    const running = await sandbox.start({ argv: ['printf', 'once'] });
    const first = running.wait();
    expect(running.wait()).toBe(first);
    expect((await first).stdout).toBe('once');
  });

  it('stops calling a listener that threw, and rejects its result with the throw', async () => {
    const { sandboxes } = fakeSandboxes({
      programs: {
        twice: (child) => {
          child.stdout('one\n');
          child.stdout('two\n');
        },
      },
    });
    const sandbox = await sandboxes.create({ template: 'base' });
    const heard: string[] = [];
    const thrown = new Error('the listener broke');
    const result = sandbox.run({
      argv: ['twice'],
      onStdout: (chunk) => {
        heard.push(chunk);
        throw thrown;
      },
    });
    await expect(result).rejects.toBe(thrown);
    expect(heard).toEqual(['one\n']);
  });

  it('kills a long-running command whose listener threw, so its result rejects at once', async () => {
    const { fake, sandboxes } = fakeSandboxes({
      programs: {
        session: async (child) => {
          child.stdout('not json\n');
          await child.killed;
        },
      },
    });
    const sandbox = await sandboxes.create({ template: 'base' });
    const running = await sandbox.start({
      argv: ['session'],
      onStdout: (line) => JSON.parse(line),
    });
    await expect(running.wait()).rejects.toThrow(SyntaxError);
    expect(fake.sandboxes[0]?.commands[0]?.state).toBe('killed');
  });

  it('keeps no output for a command that says not to, and still streams it', async () => {
    const { sandboxes } = fakeSandboxes();
    const sandbox = await sandboxes.create({ template: 'base' });
    const heard: string[] = [];
    const result = await sandbox.run({
      argv: ['printf', '%s\n', 'line'],
      keepOutput: false,
      onStdout: (chunk) => heard.push(chunk),
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(heard).toEqual(['line\n']);
  });

  it('kills nothing once the sandbox has stopped, without asking the provider', async () => {
    let kills = 0;
    const { sandboxes } = spy(
      {},
      {},
      {
        wait: () => new Promise<null>(() => undefined),
        kill: async () => {
          kills += 1;
          throw new Error('sandbox not found');
        },
      },
    );
    const sandbox = await sandboxes.create({ template: 'base' });
    const running = await sandbox.start({ argv: ['sleep', '600'] });
    await sandbox.stop();
    await running.kill();
    expect(kills).toBe(0);
  });

  it('reads and writes text as UTF-8', async () => {
    const { sandboxes } = fakeSandboxes();
    const sandbox = await sandboxes.create({ template: 'base' });
    await sandbox.writeFile('/tmp/t.txt', 'héllo ✓');
    expect(await sandbox.readFile('/tmp/t.txt')).toEqual(new TextEncoder().encode('héllo ✓'));
    expect(await sandbox.readTextFile('/tmp/t.txt')).toBe('héllo ✓');
  });

  it('gives an exposed port its URL and host', async () => {
    const { sandboxes } = spy();
    const sandbox = await sandboxes.create({ template: 'base' });
    expect(await sandbox.exposePort(7420)).toEqual({
      port: 7420,
      url: 'https://7420-spy-1.spy.test',
      host: '7420-spy-1.spy.test',
    });
  });

  it('stops once, however often or concurrently asked', async () => {
    const { calls, sandboxes } = spy();
    const sandbox = await sandboxes.create({ template: 'base' });
    await Promise.all([sandbox.stop(), sandbox.stop()]);
    await sandbox.stop();
    expect(calls.filter((call) => call === 'stop')).toEqual(['stop']);
  });

  it('refuses work once stopped, without asking the provider', async () => {
    const { calls, sandboxes } = spy();
    const sandbox = await sandboxes.create({ template: 'base' });
    const stopping = sandbox.stop();
    await expect(sandbox.run({ argv: ['true'] })).rejects.toEqual(coded('not-running', /stopped/));
    await stopping;
    await expect(sandbox.readFile('/tmp/a')).rejects.toEqual(coded('not-running'));
    await expect(sandbox.writeFile('/tmp/a', 'x')).rejects.toEqual(coded('not-running'));
    await expect(sandbox.exposePort(7420)).rejects.toEqual(coded('not-running'));
    expect(calls).toEqual(['create base', 'stop']);
  });

  it('tries a failed stop again on the next call, and still refuses work meanwhile', async () => {
    let attempts = 0;
    const { sandboxes } = spy({
      stop: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
      },
    });
    const sandbox = await sandboxes.create({ template: 'base' });
    await expect(sandbox.stop()).rejects.toEqual(coded('provider', /network down/));
    await expect(sandbox.run({ argv: ['true'] })).rejects.toEqual(coded('not-running'));
    await sandbox.stop();
    expect(attempts).toBe(2);
  });
});

describe('withSandbox', () => {
  it('stops the sandbox after the work, and returns what it returned', async () => {
    const { fake, sandboxes } = fakeSandboxes();
    const out = await sandboxes.withSandbox({ template: 'base' }, async (sandbox) => {
      return (await sandbox.run({ argv: ['printf', 'done'] })).stdout;
    });
    expect(out).toBe('done');
    expect(fake.sandboxes[0]?.state).toBe('stopped');
  });

  it('stops the sandbox when the work throws, and rethrows it', async () => {
    const { fake, sandboxes } = fakeSandboxes();
    const thrown = new Error('the work broke');
    await expect(
      sandboxes.withSandbox({ template: 'base' }, async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(fake.sandboxes[0]?.state).toBe('stopped');
  });

  it('rejects with both errors when the work and the stop fail', async () => {
    const { sandboxes } = spy({
      stop: async () => {
        throw new Error('network down');
      },
    });
    const thrown = new Error('the work broke');
    const error = await sandboxes
      .withSandbox({ template: 'base' }, async () => {
        throw thrown;
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([thrown, coded('provider', /network down/)]);
  });

  it('rejects with the stop error when only the stop fails', async () => {
    const { sandboxes } = spy({
      stop: async () => {
        throw new Error('network down');
      },
    });
    await expect(sandboxes.withSandbox({ template: 'base' }, async () => 'fine')).rejects.toEqual(
      coded('provider', /network down/),
    );
  });
});

describe('capabilities', () => {
  it('are listed in order, and absent from a provider without them', () => {
    expect(fakeSandboxes().sandboxes.capabilities).toEqual([]);
    expect(
      fakeSandboxes({ capabilities: ['keepAlive', 'snapshots', 'pausing'] }).sandboxes.capabilities,
    ).toEqual(['pausing', 'snapshots', 'keepAlive']);
    const { sandboxes } = fakeSandboxes();
    expect(sandboxes.pausing).toBeUndefined();
    expect(sandboxes.snapshots).toBeUndefined();
    expect(sandboxes.keepAlive).toBeUndefined();
  });

  it('are required with a sentence that names what is missing', () => {
    const { sandboxes } = fakeSandboxes();
    expect(() => requireCapability(sandboxes, 'pausing')).toThrow(
      'This sandbox provider cannot pause and resume sandboxes.',
    );
    expect(() => requireCapability(sandboxes, 'snapshots')).toThrow(SandboxError);
    const capable = fakeSandboxes({ capabilities: ['pausing'] }).sandboxes;
    expect(requireCapability(capable, 'pausing')).toBe(capable.pausing);
  });

  it('refuse a paused handle, which says it is paused', async () => {
    const { sandboxes } = fakeSandboxes({ capabilities: ['pausing'] });
    const pausing = requireCapability(sandboxes, 'pausing');
    const sandbox = await sandboxes.create({ template: 'base' });
    await pausing.pause(sandbox);
    await expect(sandbox.run({ argv: ['true'] })).rejects.toEqual(coded('not-running', /paused/));
    await expect(pausing.pause(sandbox)).rejects.toEqual(coded('not-running', /paused/));
    const resumed = await pausing.resume(sandbox.id);
    expect((await resumed.run({ argv: ['printf', 'up'] })).stdout).toBe('up');
  });

  it('refuse a sandbox made by other sandboxes, and resuming with no id', async () => {
    const one = fakeSandboxes({ capabilities: ['pausing', 'snapshots'] }).sandboxes;
    const other = fakeSandboxes({ capabilities: ['pausing', 'snapshots'] }).sandboxes;
    const theirs = await other.create({ template: 'base' });
    await expect(requireCapability(one, 'pausing').pause(theirs)).rejects.toEqual(coded('invalid'));
    await expect(requireCapability(one, 'snapshots').snapshot(theirs)).rejects.toEqual(
      coded('invalid'),
    );
    await expect(requireCapability(one, 'pausing').resume('')).rejects.toEqual(coded('invalid'));
  });

  it('refuse a resume that gives back another sandbox, and a snapshot with no name', async () => {
    const sandbox: ProviderSandbox = {
      id: 'spy-2',
      start: async () => ({ wait: async () => 0, kill: async () => undefined }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      exposePort: async () => 'https://spy.test',
      stop: async () => undefined,
    };
    const sandboxes = sandboxesFrom({
      ...basics(sandbox),
      create: async () => ({ ...sandbox, id: 'spy-1' }),
      pausing: { pause: async () => undefined, resume: async () => sandbox },
      snapshots: { snapshot: async () => '', remove: async () => undefined },
    });
    await expect(requireCapability(sandboxes, 'pausing').resume('spy-1')).rejects.toEqual(
      coded('provider', /gave back sandbox spy-2/),
    );
    const made = await sandboxes.create({ template: 'base' });
    await expect(requireCapability(sandboxes, 'snapshots').snapshot(made)).rejects.toEqual(
      coded('provider'),
    );
  });
  it('remove a snapshot through the provider, and refuse a removal with no name', async () => {
    const { fake, sandboxes } = fakeSandboxes({ capabilities: ['snapshots'] });
    const snapshots = requireCapability(sandboxes, 'snapshots');
    const sandbox = await sandboxes.create({ template: 'base' });
    const template = await snapshots.snapshot(sandbox);
    await snapshots.remove(template);
    await expect(sandboxes.create({ template })).rejects.toEqual(coded('not-found'));
    await expect(snapshots.remove('')).rejects.toEqual(coded('invalid', /template name/));
    await expect(snapshots.remove('base')).rejects.toEqual(
      coded('invalid', /not made by a snapshot/),
    );
    expect(fake.sandboxes).toHaveLength(1);
  });

  it("renew a sandbox's lifetime through the provider, for a handle of its own that runs", async () => {
    const { fake, sandboxes } = fakeSandboxes({ capabilities: ['keepAlive'] });
    const keepAlive = requireCapability(sandboxes, 'keepAlive');
    const sandbox = await sandboxes.create({ template: 'base', lifetimeSeconds: 60 });
    fake.elapse(50);
    await keepAlive.renew(sandbox, 600);
    expect(fake.sandboxes[0]?.remainingSeconds).toBe(600);
    await expect(keepAlive.renew(sandbox, 0)).rejects.toEqual(coded('invalid', /lifetime/));
    await expect(keepAlive.renew(sandbox, 1.5)).rejects.toEqual(coded('invalid', /lifetime/));
    const theirs = await fakeSandboxes().sandboxes.create({ template: 'base' });
    await expect(keepAlive.renew(theirs, 60)).rejects.toEqual(coded('invalid'));
    await sandbox.stop();
    await expect(keepAlive.renew(sandbox, 60)).rejects.toEqual(coded('not-running'));
  });
});

describe('a sandbox by its id', () => {
  it('is created with a lifetime, which reaches the provider, and refused a malformed one', async () => {
    const { calls, sandboxes } = spy();
    await sandboxes.create({ template: 'base', lifetimeSeconds: 900 });
    for (const lifetimeSeconds of [0, -5, 2.5, Number.NaN, '60' as never]) {
      await expect(sandboxes.create({ template: 'base', lifetimeSeconds })).rejects.toEqual(
        coded('invalid', /lifetime/),
      );
    }
    expect(calls).toEqual(['create base for 900s']);
  });

  it('is created with its ports public or locked only as asked, and refused a malformed choice', async () => {
    const { calls, sandboxes } = spy();
    await sandboxes.create({ template: 'base', publicPorts: true });
    await sandboxes.create({ template: 'base', publicPorts: false });
    await sandboxes.create({ template: 'base' });
    await expect(sandboxes.create({ template: 'base', publicPorts: 1 as never })).rejects.toEqual(
      coded('invalid', /public ports/),
    );
    expect(calls).toEqual([
      'create base publicPorts true',
      'create base publicPorts false',
      'create base',
    ]);
  });

  it('is attached to, and stopped, through the provider', async () => {
    const { calls, sandboxes } = spy();
    const attached = await sandboxes.attach('spy-1');
    expect(attached.id).toBe('spy-1');
    expect((await attached.run({ argv: ['printf', 'x'] })).exitCode).toBe(0);
    await sandboxes.stop('spy-1');
    expect(calls).toEqual(['attach spy-1', 'start printf x', 'stop spy-1']);
  });

  it('is refused with no id, before the provider sees it', async () => {
    const { calls, sandboxes } = spy();
    for (const sandboxId of ['', '  ', 7 as never, undefined as never]) {
      await expect(sandboxes.attach(sandboxId)).rejects.toEqual(coded('invalid', /id of a/));
      await expect(sandboxes.stop(sandboxId)).rejects.toEqual(coded('invalid', /id of a/));
    }
    expect(calls).toEqual([]);
  });

  it("keeps the provider's code when there is none to attach to", async () => {
    const { sandboxes } = fakeSandboxes();
    await expect(sandboxes.attach('fake-9')).rejects.toEqual(coded('not-found'));
    await sandboxes.stop('fake-9');
  });
});
