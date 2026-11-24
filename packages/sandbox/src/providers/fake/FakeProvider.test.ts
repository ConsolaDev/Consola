import { describe, expect, it } from 'vitest';
import { sandboxesFrom } from '../../application/sandboxes';
import { SandboxError } from '../../domain/errors';
import { FAKE_DEFAULT_CWD, type FakeProcess, FakeProvider } from './FakeProvider';
import { POSIX_PROGRAMS } from './posixPrograms';

const coded = (code: SandboxError['code'], message?: RegExp) =>
  expect.objectContaining({ code, ...(message && { message: expect.stringMatching(message) }) });

describe('FakeProvider', () => {
  it('starts sandboxes from its templates, with their files, and numbers them', async () => {
    const fake = new FakeProvider({
      templates: { 'consola-session': { files: { '/opt/consola/start': 'run\n' } } },
    });
    const first = await fake.create({ template: 'consola-session', env: { A: '1' } });
    const second = await fake.create({ template: 'consola-session' });
    expect([first.id, second.id]).toEqual(['fake-1', 'fake-2']);
    expect(new TextDecoder().decode(await first.readFile('/opt/consola/start'))).toBe('run\n');
    expect(
      fake.sandboxes.map(({ id, template, env, state }) => ({ id, template, env, state })),
    ).toEqual([
      { id: 'fake-1', template: 'consola-session', env: { A: '1' }, state: 'running' },
      { id: 'fake-2', template: 'consola-session', env: {}, state: 'running' },
    ]);
  });

  it('has one empty template, base, unless told otherwise', async () => {
    const sandbox = await new FakeProvider().create({ template: 'base' });
    expect(sandbox.id).toBe('fake-1');
    await expect(new FakeProvider().create({ template: 'node' })).rejects.toEqual(
      coded('not-found', /no template named node/),
    );
  });

  it('fails a create the way failCreate says, and records nothing', async () => {
    const fake = new FakeProvider({
      failCreate: ({ template }) => (template === 'base' ? 'Team quota reached' : null),
    });
    await expect(fake.create({ template: 'base' })).rejects.toEqual(
      coded('provider', /^Team quota reached$/),
    );
    expect(fake.sandboxes).toEqual([]);
  });

  it('refuses a capability it does not know', () => {
    expect(() => new FakeProvider({ capabilities: ['teleport' as never] })).toThrow(SandboxError);
  });

  it('offers no capability unless asked to', () => {
    const fake = new FakeProvider();
    expect(fake.pausing).toBeUndefined();
    expect(fake.snapshots).toBeUndefined();
    expect(fake.keepAlive).toBeUndefined();
  });

  it('records whether each sandbox was created with its ports public', async () => {
    const fake = new FakeProvider();
    await fake.create({ template: 'base', publicPorts: true });
    await fake.create({ template: 'base', publicPorts: false });
    await fake.create({ template: 'base' });
    expect(fake.sandboxes.map((s) => s.publicPorts)).toEqual([true, false, false]);
  });

  it('stops a sandbox once its lifetime runs out on its clock, which only a test moves', async () => {
    const fake = new FakeProvider({ programs: POSIX_PROGRAMS });
    const brief = await fake.create({ template: 'base', lifetimeSeconds: 60 });
    await fake.create({ template: 'base' });
    const sleeping = await brief.start({ argv: ['sleep', '600'] });
    expect(fake.sandboxes.map((s) => [s.lifetimeSeconds, s.remainingSeconds])).toEqual([
      [60, 60],
      [null, null],
    ]);

    fake.elapse(59.5);
    expect(fake.sandboxes[0]).toMatchObject({ state: 'running', remainingSeconds: 0.5 });
    fake.elapse(0.5);
    expect(await sleeping.wait()).toBeNull();
    expect(fake.sandboxes.map((s) => [s.state, s.remainingSeconds])).toEqual([
      ['stopped', 0],
      ['running', null],
    ]);
    await expect(brief.start({ argv: ['true'] })).rejects.toEqual(coded('not-running'));
    expect(() => fake.elapse(-1)).toThrow(SandboxError);
  });

  it('keeps a paused sandbox from ageing', async () => {
    const fake = new FakeProvider({ capabilities: ['pausing'] });
    const sandbox = await fake.create({ template: 'base', lifetimeSeconds: 60 });
    await fake.pausing?.pause(sandbox.id);
    fake.elapse(600);
    await fake.pausing?.resume(sandbox.id);
    expect(fake.sandboxes[0]).toMatchObject({ state: 'running', remainingSeconds: 60 });
  });

  it('renews a lifetime from now, longer or shorter, only while the sandbox runs', async () => {
    const fake = new FakeProvider({ capabilities: ['keepAlive'] });
    const keepAlive = fake.keepAlive;
    if (!keepAlive) throw new Error('The fake was asked for keepAlive.');
    const sandbox = await fake.create({ template: 'base', lifetimeSeconds: 60 });
    fake.elapse(50);
    await keepAlive.renew(sandbox.id, 300);
    expect(fake.sandboxes[0]?.remainingSeconds).toBe(300);
    await keepAlive.renew(sandbox.id, 5);
    fake.elapse(5);
    expect(fake.sandboxes[0]?.state).toBe('stopped');
    await expect(keepAlive.renew(sandbox.id, 60)).rejects.toEqual(coded('not-running'));
  });

  it('attaches to a running sandbox by its id, and refuses one paused, stopped or never made', async () => {
    const fake = new FakeProvider({ capabilities: ['pausing'] });
    const sandbox = await fake.create({ template: 'base', lifetimeSeconds: 60 });
    await sandbox.writeFile('/tmp/mine', new TextEncoder().encode('mine'));
    const attached = await fake.attach(sandbox.id);
    expect(attached.id).toBe(sandbox.id);
    expect(new TextDecoder().decode(await attached.readFile('/tmp/mine'))).toBe('mine');
    expect(fake.sandboxes[0]?.remainingSeconds).toBe(60);

    await fake.pausing?.pause(sandbox.id);
    await expect(fake.attach(sandbox.id)).rejects.toEqual(coded('not-running', /paused/));
    await fake.pausing?.resume(sandbox.id);
    await sandbox.stop();
    await expect(fake.attach(sandbox.id)).rejects.toEqual(coded('not-found'));
    await expect(fake.attach('fake-9')).rejects.toEqual(coded('not-found'));
  });

  it('stops a sandbox by its id for every handle on it, and stops nothing for an unknown id', async () => {
    const fake = new FakeProvider({ programs: POSIX_PROGRAMS });
    const sandbox = await fake.create({ template: 'base' });
    const attached = await fake.attach(sandbox.id);
    const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
    await fake.stop(sandbox.id);
    expect(await sleeping.wait()).toBeNull();
    await expect(sandbox.readFile('/tmp/x')).rejects.toEqual(coded('not-running'));
    await expect(attached.readFile('/tmp/x')).rejects.toEqual(coded('not-running'));
    await fake.stop(sandbox.id);
    await fake.stop('fake-9');
    expect(fake.sandboxes.map((s) => s.state)).toEqual(['stopped']);
  });

  it("hands a program its command line, folder, variables and the sandbox's files", async () => {
    let seen: FakeProcess | undefined;
    const fake = new FakeProvider({
      programs: {
        look: (child) => {
          seen = child;
          child.files.write('relative.txt', child.files.readText('/tmp/in.txt') ?? 'missing');
        },
      },
    });
    const sandbox = await fake.create({ template: 'base', env: { SANDBOX: 's', BOTH: 's' } });
    await sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('from the file call'));
    const command = await sandbox.start({ argv: ['look', 'x'], env: { BOTH: 'c' } });
    expect(await command.wait()).toBe(0);
    expect(seen).toMatchObject({
      argv: ['look', 'x'],
      cwd: FAKE_DEFAULT_CWD,
      env: { SANDBOX: 's', BOTH: 'c' },
    });
    const written = await sandbox.readFile(`${FAKE_DEFAULT_CWD}/relative.txt`);
    expect(new TextDecoder().decode(written)).toBe('from the file call');
  });

  it('records each command as it runs and ends', async () => {
    const fake = new FakeProvider({ programs: POSIX_PROGRAMS });
    const sandbox = await fake.create({ template: 'base' });
    await (await sandbox.start({ argv: ['printf', 'hi'], cwd: '/tmp/./x/..' })).wait();
    await (await sandbox.start({ argv: ['cat', '/none'] })).wait();
    expect(fake.sandboxes[0]?.commands).toEqual([
      expect.objectContaining({
        argv: ['printf', 'hi'],
        cwd: '/tmp',
        state: 'exited',
        exitCode: 0,
        stdout: 'hi',
        stderr: '',
      }),
      expect.objectContaining({
        state: 'exited',
        exitCode: 1,
        stderr: expect.stringMatching(/No such file/),
      }),
    ]);
  });

  it('ends a program it does not have with 127, as a shell does', async () => {
    const sandbox = await new FakeProvider().create({ template: 'base' });
    const out: string[] = [];
    const command = await sandbox.start({
      argv: ['gh', 'pr', 'view'],
      onStderr: (c) => out.push(c),
    });
    expect(await command.wait()).toBe(127);
    expect(out).toEqual(['gh: command not found\n']);
  });

  it('rejects a command whose program throws, keeping a SandboxError code', async () => {
    const fake = new FakeProvider({
      programs: {
        drop: () => {
          throw new Error('connection reset');
        },
        gone: async () => {
          throw new SandboxError('not-running', 'The sandbox timed out.');
        },
      },
    });
    const sandbox = await fake.create({ template: 'base' });
    await expect((await sandbox.start({ argv: ['drop'] })).wait()).rejects.toEqual(
      coded('provider', /connection reset/),
    );
    await expect((await sandbox.start({ argv: ['gone'] })).wait()).rejects.toEqual(
      coded('not-running', /timed out/),
    );
    expect(fake.sandboxes[0]?.commands.map((command) => command.state)).toEqual([
      'failed',
      'failed',
    ]);
  });

  it('rejects a command whose program returns something that is no exit code', async () => {
    const fake = new FakeProvider({ programs: { odd: () => 300 } });
    const sandbox = await fake.create({ template: 'base' });
    await expect((await sandbox.start({ argv: ['odd'] })).wait()).rejects.toEqual(
      coded('provider', /returned 300/),
    );
  });

  it('leaves no unhandled rejection behind for a failed command nobody waits for', async () => {
    const fake = new FakeProvider({
      programs: {
        drop: () => {
          throw new Error('connection reset');
        },
      },
    });
    const sandbox = await fake.create({ template: 'base' });
    await sandbox.start({ argv: ['drop'] });
    // Vitest fails the run on an unhandled rejection, so passing here is the assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.sandboxes[0]?.commands[0]?.state).toBe('failed');
  });

  it('ends a killed command with null, drops its later output, and ignores its return', async () => {
    let child: FakeProcess | undefined;
    let finish = (_code: number): void => undefined;
    const fake = new FakeProvider({
      programs: {
        serve: (started) => {
          child = started;
          return new Promise<number>((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    const sandbox = await fake.create({ template: 'base' });
    const command = await sandbox.start({ argv: ['serve'] });
    await Promise.resolve();
    child?.stdout('before\n');
    await command.kill();
    child?.stdout('after\n');
    finish(0);
    expect(await command.wait()).toBeNull();
    expect(fake.sandboxes[0]?.commands[0]).toMatchObject({
      state: 'killed',
      exitCode: null,
      stdout: 'before\n',
    });
    await command.kill();
  });

  it('kills running commands and refuses work when it stops', async () => {
    const fake = new FakeProvider({ programs: POSIX_PROGRAMS });
    const sandbox = await fake.create({ template: 'base' });
    const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
    await sandbox.stop();
    await sandbox.stop();
    expect(await sleeping.wait()).toBeNull();
    expect(fake.sandboxes[0]?.state).toBe('stopped');
    await expect(sandbox.start({ argv: ['true'] })).rejects.toEqual(coded('not-running'));
    await expect(sandbox.readFile('/tmp/a')).rejects.toEqual(coded('not-running'));
    await expect(sandbox.writeFile('/tmp/a', new Uint8Array())).rejects.toEqual(
      coded('not-running'),
    );
    await expect(sandbox.exposePort(7420)).rejects.toEqual(coded('not-running'));
  });

  it('exposes a port at an address naming the port and the sandbox, and records it once', async () => {
    const fake = new FakeProvider();
    const sandbox = await fake.create({ template: 'base' });
    expect(await sandbox.exposePort(7420)).toBe('https://7420-fake-1.fake-sandbox.test');
    await sandbox.exposePort(7420);
    await sandbox.exposePort(8080);
    expect(fake.sandboxes[0]?.exposedPorts).toEqual([7420, 8080]);
  });

  it('copies bytes in and out, so nobody shares them with its files', async () => {
    const fake = new FakeProvider();
    const sandbox = await fake.create({ template: 'base' });
    const bytes = new Uint8Array([1, 2, 3]);
    await sandbox.writeFile('/tmp/b', bytes);
    bytes[0] = 9;
    const read = await sandbox.readFile('/tmp/b');
    read[1] = 9;
    expect([...(await sandbox.readFile('/tmp/b'))]).toEqual([1, 2, 3]);
    expect(fake.sandboxes[0]?.files.paths()).toEqual(['/tmp/b']);
  });

  it('pauses a sandbox, ending its commands, and resumes it with its files', async () => {
    const fake = new FakeProvider({ programs: POSIX_PROGRAMS, capabilities: ['pausing'] });
    const pausing = fake.pausing;
    if (!pausing) throw new Error('The fake was asked for pausing.');
    const sandbox = await fake.create({ template: 'base' });
    await sandbox.writeFile('/tmp/kept', new TextEncoder().encode('kept'));
    const sleeping = await sandbox.start({ argv: ['sleep', '1'] });
    await pausing.pause(sandbox.id);
    expect(await sleeping.wait()).toBeNull();
    expect(fake.sandboxes[0]?.state).toBe('paused');
    await expect(sandbox.readFile('/tmp/kept')).rejects.toEqual(coded('not-running', /paused/));
    await expect(pausing.pause(sandbox.id)).rejects.toEqual(coded('not-running'));

    const resumed = await pausing.resume(sandbox.id);
    expect(new TextDecoder().decode(await resumed.readFile('/tmp/kept'))).toBe('kept');
    await resumed.stop();
    await expect(pausing.resume(sandbox.id)).rejects.toEqual(coded('not-found'));
    await expect(pausing.pause('fake-9')).rejects.toEqual(coded('not-found'));
  });

  it('saves a snapshot of the files as they were, as a template', async () => {
    const fake = new FakeProvider({ capabilities: ['snapshots'] });
    const snapshots = fake.snapshots;
    if (!snapshots) throw new Error('The fake was asked for snapshots.');
    const sandbox = await fake.create({ template: 'base' });
    await sandbox.writeFile('/tmp/a', new TextEncoder().encode('before'));
    const template = await snapshots.snapshot(sandbox.id);
    await sandbox.writeFile('/tmp/a', new TextEncoder().encode('after'));
    expect(template).toBe('snapshot-1');
    const restored = await fake.create({ template });
    expect(new TextDecoder().decode(await restored.readFile('/tmp/a'))).toBe('before');
    await sandbox.stop();
    await expect(snapshots.snapshot(sandbox.id)).rejects.toEqual(coded('not-running'));
  });

  it('removes only the snapshots it made, and removing one twice does nothing', async () => {
    const fake = new FakeProvider({ capabilities: ['snapshots'] });
    const snapshots = fake.snapshots;
    if (!snapshots) throw new Error('The fake was asked for snapshots.');
    const sandbox = await fake.create({ template: 'base' });
    const template = await snapshots.snapshot(sandbox.id);
    await snapshots.remove(template);
    await snapshots.remove(template);
    await snapshots.remove('never-made');
    await expect(fake.create({ template })).rejects.toEqual(coded('not-found'));
    await expect(snapshots.remove('base')).rejects.toEqual(coded('invalid'));
    expect((await fake.create({ template: 'base' })).id).toBe('fake-2');
  });

  it('never runs the program of a command its sandbox stopped before it began', async () => {
    let ran = false;
    const fake = new FakeProvider({
      programs: {
        write: (child) => {
          ran = true;
          child.files.write('/tmp/side-effect', 'x');
        },
      },
    });
    const sandbox = await fake.create({ template: 'base' });
    // The stop lands between the start and the program's first turn.
    const starting = sandbox.start({ argv: ['write'] });
    await sandbox.stop();
    expect(await (await starting).wait()).toBeNull();
    expect(ran).toBe(false);
    expect(fake.sandboxes[0]?.files.paths()).toEqual([]);
  });

  it('lets a test drive a long-running command step by step, as a runner test does', async () => {
    let session: FakeProcess | undefined;
    let end = (): void => undefined;
    const fake = new FakeProvider({
      templates: { 'consola-session': {} },
      programs: {
        'consola-session-start': (child) => {
          session = child;
          return new Promise<number>((resolve) => {
            end = () => resolve(0);
          });
        },
      },
    });
    const sandboxes = sandboxesFrom(fake);
    const sandbox = await sandboxes.create({
      template: 'consola-session',
      env: { CONSOLA_HARNESS: 'claude', ANTHROPIC_API_KEY: 'test' },
    });
    const lines: string[] = [];
    const running = await sandbox.start({
      argv: ['consola-session-start'],
      onStdout: (chunk) => lines.push(chunk),
    });
    await Promise.resolve();

    session?.stdout('{"type":"ready","port":7420}\n');
    expect(lines).toEqual(['{"type":"ready","port":7420}\n']);
    expect((await sandbox.exposePort(7420)).url).toBe('https://7420-fake-1.fake-sandbox.test');

    end();
    expect(await running.wait()).toMatchObject({ exitCode: 0 });
    await sandbox.stop();
    expect(fake.sandboxes[0]).toMatchObject({
      env: { CONSOLA_HARNESS: 'claude', ANTHROPIC_API_KEY: 'test' },
      state: 'stopped',
      exposedPorts: [7420],
    });
    expect(fake.sandboxes[0]?.env).not.toHaveProperty('OPENAI_API_KEY');
  });
});
