import { execFileSync } from 'node:child_process';
import {
  CommandExitError,
  SandboxError as E2BError,
  FileNotFoundError,
  SandboxNotFoundError,
  SandboxNotRunningError,
} from 'e2b';
import { describe, expect, it, vi } from 'vitest';
import { sandboxesFrom } from '../../application/sandboxes';
import type { SandboxError } from '../../domain/errors';
import { commandLineOf } from './commandLine';
import { E2BProvider } from './E2BProvider';
import type { E2BApi, E2BCommandHandle, E2BCommandOptions, E2BSandbox } from './e2bApi';

/**
 * The provider's translation, against a stand-in for E2B's SDK: no network, and every option
 * the provider would have sent to E2B in view. The contract runs it against real E2B
 * (`src/contract.test.ts`) when a key is set.
 */

const KEY = 'e2b_acme_test_key_0000';

const coded = (code: SandboxError['code'], message?: RegExp) =>
  expect.objectContaining({ code, ...(message && { message: expect.stringMatching(message) }) });

/** E2B's error for an API answer with `status`. */
const answered = (status: number, message: string): E2BError =>
  Object.assign(new E2BError(`${status}: ${message}`), { statusCode: status });

class StubCommand {
  kills = 0;
  disconnects = 0;
  readonly done: Promise<unknown>;
  private settle = { resolve: (_value: unknown) => {}, reject: (_error: unknown) => {} };

  constructor(
    readonly cmd: string,
    readonly options: E2BCommandOptions,
  ) {
    this.done = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.done.catch(() => undefined);
  }

  readonly handle: E2BCommandHandle = {
    wait: () => this.done,
    kill: async () => {
      this.kills += 1;
      this.exit(-1);
      return true;
    },
    // As E2B's: its stream is aborted, so its wait rejects.
    disconnect: async () => {
      this.disconnects += 1;
      this.fail(new Error('The operation was aborted.'));
    },
  };

  print(text: string): void {
    this.options.onStdout(text);
  }

  /** Ends it as E2B reports an exit: 0 resolves, anything else is a `CommandExitError`. */
  exit(exitCode: number): void {
    if (exitCode === 0) {
      this.settle.resolve({ exitCode, stdout: '', stderr: '' });
      return;
    }
    const error = exitCode < 0 ? 'signal: killed' : `exit status ${exitCode}`;
    this.settle.reject(new CommandExitError({ exitCode, error, stdout: '', stderr: '' }));
  }

  fail(error: unknown): void {
    this.settle.reject(error);
  }
}

class StubSandbox implements E2BSandbox {
  readonly commands: StubCommand[] = [];
  readonly files = new Map<string, Uint8Array>();
  running = true;
  readonly kill = vi.fn(async () => true);
  readonly isRunning = vi.fn(async () => this.running);
  readonly readFile = vi.fn(async (path: string) => {
    const content = this.files.get(path);
    if (!content) throw new FileNotFoundError(`path '${path}' does not exist`);
    return content;
  });
  readonly writeFile = vi.fn(async (path: string, content: Uint8Array) => {
    this.files.set(path, content);
  });

  constructor(readonly sandboxId: string) {}

  async startCommand(cmd: string, options: E2BCommandOptions): Promise<E2BCommandHandle> {
    const command = new StubCommand(cmd, options);
    this.commands.push(command);
    return command.handle;
  }

  getHost(port: number): string {
    return `${port}-${this.sandboxId}.e2b.app`;
  }

  /** The command started last. */
  get last(): StubCommand {
    const command = this.commands.at(-1);
    if (!command) throw new Error('No command was started.');
    return command;
  }
}

function stubbed() {
  const made: StubSandbox[] = [];
  const make = (sandboxId = `sbx-acme-${made.length + 1}`): StubSandbox => {
    const sandbox = new StubSandbox(sandboxId);
    made.push(sandbox);
    return sandbox;
  };
  const api = {
    create: vi.fn<E2BApi['create']>(async () => make()),
    connect: vi.fn<E2BApi['connect']>(async (sandboxId) => make(sandboxId)),
    getInfo: vi.fn<E2BApi['getInfo']>(async () => ({ state: 'running' as const })),
    kill: vi.fn<E2BApi['kill']>(async () => true),
    setTimeout: vi.fn<E2BApi['setTimeout']>(async () => undefined),
  };
  const provider = new E2BProvider({ apiKey: KEY }, api);
  const sandbox = async () => {
    const handle = await provider.create({ template: 'base' });
    const inner = made.at(-1);
    if (!inner) throw new Error('Nothing was made.');
    return { handle, inner };
  };
  return { api, provider, made, sandbox };
}

describe('E2BProvider', () => {
  it('refuses to start without an API key', () => {
    for (const apiKey of ['', '   ', undefined as never]) {
      expect(() => new E2BProvider({ apiKey })).toThrow(
        expect.objectContaining({ code: 'invalid' }),
      );
    }
  });

  it("creates a sandbox with its variables, its lifetime as E2B's timeout, killed when it runs out, and its ports open to whoever has their address", async () => {
    const { api, provider } = stubbed();
    const handle = await provider.create({
      template: 'consola-session',
      env: { CONSOLA_HARNESS: 'claude' },
      lifetimeSeconds: 900,
    });
    await provider.create({ template: 'base' });
    expect(handle.id).toBe('sbx-acme-1');
    expect(api.create.mock.calls).toEqual([
      [
        'consola-session',
        {
          envs: { CONSOLA_HARNESS: 'claude' },
          timeoutMs: 900_000,
          lifecycle: { onTimeout: 'kill' },
          network: { allowPublicTraffic: true },
        },
      ],
      ['base', { lifecycle: { onTimeout: 'kill' }, network: { allowPublicTraffic: true } }],
    ]);
  });

  it("reports a missing template as not-found, and anything else in E2B's words, never the key", async () => {
    const { api, provider } = stubbed();
    api.create.mockRejectedValueOnce(answered(404, "template 'sprocket' not found"));
    await expect(provider.create({ template: 'sprocket' })).rejects.toEqual(
      coded('not-found', /template 'sprocket' not found/),
    );

    api.create.mockRejectedValueOnce(answered(401, `the key ${KEY} is not valid`));
    const error = await provider.create({ template: 'base' }).catch((e: unknown) => e);
    expect(error).toEqual(coded('provider', /the key \[the E2B API key\] is not valid/));
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect((error as Error).message).not.toContain(KEY);
    expect((error as Error).cause).toBeUndefined();
  });

  it('starts each command in the background with no time limit, keeping none of its output', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    await handle.start({ argv: ['pwd'], cwd: '/workspace/repo', env: { GIT_TOKEN: 'x' } });
    await handle.start({ argv: ['pwd'] });
    const [first, second] = inner.commands;
    expect(first?.options).toMatchObject({
      cwd: '/workspace/repo',
      envs: { GIT_TOKEN: 'x' },
      retainOutput: false,
      timeoutMs: 0,
    });
    expect(second?.options).not.toHaveProperty('cwd');
    expect(second?.options).not.toHaveProperty('envs');
  });

  it('ends a command with its exit code, or with null when a signal ended it', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    const codes: Array<number | null> = [];
    for (const exitCode of [0, 2, 127, -1]) {
      const started = await handle.start({ argv: ['true'] });
      inner.last.exit(exitCode);
      codes.push(await started.wait());
    }
    expect(codes).toEqual([0, 2, 127, null]);
  });

  it('ends a command with null when its sandbox went away under it, and reports any other failure', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();

    const gone = await handle.start({ argv: ['sleep', '600'] });
    inner.last.fail(new SandboxNotRunningError('The sandbox was killed or reached its timeout'));
    expect(await gone.wait()).toBeNull();

    const unsaid = await handle.start({ argv: ['sleep', '600'] });
    inner.running = false;
    inner.last.fail(new Error('stream reset'));
    expect(await unsaid.wait()).toBeNull();

    const broken = await handle.start({ argv: ['sleep', '600'] });
    inner.running = true;
    inner.last.fail(new Error('stream reset'));
    await expect(broken.wait()).rejects.toEqual(coded('provider', /stream reset/));
  });

  it('streams output to the listeners until the command ends, and never after', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    const heard: string[] = [];
    const started = await handle.start({
      argv: ['tail', '-f', '/tmp/log'],
      onStdout: (c) => heard.push(c),
    });
    inner.last.print('ready\n');
    inner.last.exit(0);
    await started.wait();
    inner.last.print('late\n');
    expect(heard).toEqual(['ready\n']);
  });

  it('kills a command through E2B, and does nothing for one that ended or whose sandbox is gone', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    const killed = await handle.start({ argv: ['sleep', '600'] });
    await killed.kill();
    expect(await killed.wait()).toBeNull();
    await killed.kill();
    expect(inner.last.kills).toBe(1);

    const orphan = await handle.start({ argv: ['sleep', '600'] });
    inner.last.handle.kill = async () => {
      throw new SandboxNotRunningError('The sandbox was not found');
    };
    await orphan.kill();
  });

  it('stops once: ends its commands with null, kills the sandbox, then refuses work without asking E2B', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    const heard: string[] = [];
    const sleeping = await handle.start({ argv: ['sleep', '600'], onStdout: (c) => heard.push(c) });
    await handle.stop();
    expect(await sleeping.wait()).toBeNull();
    inner.commands[0]?.print('after the stop\n');
    expect(heard).toEqual([]);
    expect(inner.commands[0]?.disconnects).toBe(1);
    await inner.commands[0]?.done.catch(() => undefined);
    expect(inner.isRunning).not.toHaveBeenCalled();
    await handle.stop();
    expect(inner.kill).toHaveBeenCalledTimes(1);

    await expect(handle.start({ argv: ['true'] })).rejects.toEqual(coded('not-running'));
    await expect(handle.readFile('/tmp/x')).rejects.toEqual(coded('not-running'));
    await expect(handle.writeFile('/tmp/x', new Uint8Array())).rejects.toEqual(
      coded('not-running'),
    );
    await expect(handle.exposePort(7420)).rejects.toEqual(coded('not-running'));
    expect(inner.commands).toHaveLength(1);
    expect(inner.readFile).not.toHaveBeenCalled();
  });

  it('tries a failed kill again on the next stop, and takes a sandbox already gone as stopped', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    inner.kill.mockRejectedValueOnce(new Error('network down'));
    await expect(handle.stop()).rejects.toEqual(coded('provider', /network down/));
    await handle.stop();
    expect(inner.kill).toHaveBeenCalledTimes(2);

    const other = await sandbox();
    other.inner.kill.mockRejectedValueOnce(new SandboxNotRunningError('The sandbox was not found'));
    await other.handle.stop();
    await other.handle.stop();
    expect(other.inner.kill).toHaveBeenCalledTimes(1);
  });

  it('reads and writes files, a missing one as not-found', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    await expect(handle.readFile('/tmp/none')).rejects.toEqual(coded('not-found', /none/));
    const bytes = Uint8Array.from([0, 1, 255]);
    await handle.writeFile('/tmp/bytes', bytes);
    const read = await handle.readFile('/tmp/bytes');
    expect(read).toEqual(bytes);
    expect(read).not.toBe(inner.files.get('/tmp/bytes'));
  });

  it('reports a call on a sandbox E2B stopped (a timeout, another handle) as not-running', async () => {
    const { sandbox } = stubbed();
    const { handle, inner } = await sandbox();
    inner.readFile.mockRejectedValueOnce(new SandboxNotRunningError('The sandbox was not found'));
    await expect(handle.readFile('/tmp/x')).rejects.toEqual(coded('not-running'));
  });

  it("exposes a port at https on E2B's host for it", async () => {
    const { sandbox } = stubbed();
    const { handle } = await sandbox();
    expect(await handle.exposePort(7420)).toBe('https://7420-sbx-acme-1.e2b.app');
  });

  it('attaches to a running sandbox without lengthening its life', async () => {
    const { api, provider } = stubbed();
    const attached = await provider.attach('sbx-sprocket-7');
    expect(attached.id).toBe('sbx-sprocket-7');
    expect(api.getInfo).toHaveBeenCalledWith('sbx-sprocket-7');
    expect(api.connect.mock.calls).toEqual([['sbx-sprocket-7', { timeoutMs: 1_000 }]]);
  });

  it('refuses to attach to a paused sandbox, and never resumes it', async () => {
    const { api, provider } = stubbed();
    api.getInfo.mockResolvedValueOnce({ state: 'paused' });
    await expect(provider.attach('sbx-sprocket-7')).rejects.toEqual(coded('not-running', /paused/));
    expect(api.connect).not.toHaveBeenCalled();
  });

  it('refuses to attach to a sandbox that has stopped, or never was, as not-found', async () => {
    const { api, provider } = stubbed();
    api.getInfo.mockRejectedValueOnce(new SandboxNotFoundError('Sandbox sbx-1 not found'));
    await expect(provider.attach('sbx-1')).rejects.toEqual(coded('not-found'));
    api.getInfo.mockRejectedValueOnce(answered(400, 'Invalid sandbox ID'));
    await expect(provider.attach('no-such')).rejects.toEqual(coded('not-found', /no-such/));
    api.connect.mockRejectedValueOnce(new SandboxNotFoundError('Paused sandbox sbx-2 not found'));
    await expect(provider.attach('sbx-2')).rejects.toEqual(coded('not-found'));
    api.getInfo.mockRejectedValueOnce(answered(500, 'internal error'));
    await expect(provider.attach('sbx-3')).rejects.toEqual(coded('provider', /internal error/));
  });

  it('stops a sandbox by its id, and nothing for an id that was never one', async () => {
    const { api, provider } = stubbed();
    await provider.stop('sbx-acme-4');
    expect(api.kill).toHaveBeenCalledWith('sbx-acme-4');
    api.kill.mockResolvedValueOnce(false);
    await provider.stop('sbx-acme-4');
    api.kill.mockRejectedValueOnce(answered(400, 'Invalid sandbox ID'));
    await provider.stop('no-such');
    api.kill.mockRejectedValueOnce(answered(503, 'Service temporarily unavailable'));
    await expect(provider.stop('sbx-acme-4')).rejects.toEqual(coded('provider', /unavailable/));
  });

  it("renews a lifetime as E2B's timeout from now, and a sandbox that is gone as not-running", async () => {
    const { api, provider } = stubbed();
    await provider.keepAlive.renew('sbx-acme-1', 600);
    expect(api.setTimeout.mock.calls).toEqual([['sbx-acme-1', 600_000]]);
    api.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError('Sandbox sbx-acme-1 not found'));
    await expect(provider.keepAlive.renew('sbx-acme-1', 600)).rejects.toEqual(coded('not-running'));
  });

  it('declares keepAlive, and neither pausing nor snapshots', () => {
    expect(sandboxesFrom(stubbed().provider).capabilities).toEqual(['keepAlive']);
  });

  it('collects output and exit codes through sandboxesFrom, as code uses it', async () => {
    const { provider, made } = stubbed();
    const sandboxes = sandboxesFrom(provider);
    const sandbox = await sandboxes.create({ template: 'base' });
    const running = await sandbox.start({ argv: ['printf', 'hi'] });
    made[0]?.last.print('hi');
    made[0]?.last.exit(1);
    expect(await running.wait()).toEqual({ exitCode: 1, stdout: 'hi', stderr: '' });
  });
});

describe("E2B's command line", () => {
  it("carries the program and its arguments as the shell's own arguments, the last as the line", () => {
    expect(commandLineOf(['pwd'])).toEqual({
      shell: ['/bin/sh', '-c', 'exec "$@"', 'sh'],
      cmd: 'pwd',
    });
    expect(commandLineOf(['printf', '%s|', 'a b'])).toEqual({
      shell: ['/bin/sh', '-c', 'exec "$@"', 'sh', 'printf', '%s|'],
      cmd: 'a b',
    });
  });

  it('hands a real sh every argument as it is, with no parsing between', () => {
    const args = [
      '$HOME',
      '"double"',
      "it's",
      '*',
      '$(echo run)',
      '`echo run`',
      'two  spaces',
      'semi;colon && more',
      'back\\slash',
      'new\nline',
      '-n',
      '',
    ];
    // As E2B starts it: the shell's executable, its own arguments, then the command line.
    const { shell, cmd } = commandLineOf(['printf', '%s|', ...args]);
    const [executable = '', ...rest] = shell;
    const out = execFileSync(executable, [...rest, cmd], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(out).toBe(args.map((arg) => `${arg}|`).join(''));
  });

  it('ends a program that is not there with 127, as the contract asks', () => {
    const { shell, cmd } = commandLineOf(['consola-no-such-program']);
    const [executable = '', ...rest] = shell;
    let status: number | null = null;
    try {
      execFileSync(executable, [...rest, cmd], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(127);
  });
});
