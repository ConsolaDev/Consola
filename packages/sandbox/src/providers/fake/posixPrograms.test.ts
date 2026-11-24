import { describe, expect, it } from 'vitest';
import { sandboxesFrom } from '../../application/sandboxes';
import type { Sandbox } from '../../application/sandboxes';
import { FakeProvider } from './FakeProvider';
import { POSIX_PROGRAMS } from './posixPrograms';

async function sandbox(files: Record<string, string> = {}): Promise<Sandbox> {
  const fake = new FakeProvider({ programs: POSIX_PROGRAMS, templates: { base: { files } } });
  return sandboxesFrom(fake).create({ template: 'base', env: { HOME: '/home/user', LANG: 'C' } });
}

describe('the POSIX stand-ins', () => {
  it.each<[string[], string, number]>([
    [['printf', 'plain'], 'plain', 0],
    [['printf', '%s\n', 'a', 'b'], 'a\nb\n', 0],
    [['printf', '%s=%s;', 'a', '1', 'b'], 'a=1;b=;', 0],
    [['printf', '100%% %s\\t\\\\', 'x'], '100% x\t\\', 0],
    [['printf', '%s', '$HOME *'], '$HOME *', 0],
    [['printf', 'no args used', 'extra'], 'no args used', 0],
    [['printf', '%s|'], '|', 0],
    [['printf', '%d', '1'], '', 2],
    [['printf', '\\x41'], '', 2],
    [['printf'], '', 1],
  ])('printf %j prints %j and exits %i', async (argv, stdout, exitCode) => {
    const result = await (await sandbox()).run({ argv });
    expect({ stdout: result.stdout, exitCode: result.exitCode }).toEqual({ stdout, exitCode });
  });

  it('cat prints each file in turn, and reports a missing one', async () => {
    const box = await sandbox({ '/tmp/a': 'A\n', '/tmp/b': 'B\n' });
    expect(await box.run({ argv: ['cat', '/tmp/a', '/tmp/none', '/tmp/b'] })).toEqual({
      exitCode: 1,
      stdout: 'A\nB\n',
      stderr: 'cat: /tmp/none: No such file or directory\n',
    });
    expect((await box.run({ argv: ['cat', 'a'], cwd: '/tmp' })).stdout).toBe('A\n');
    expect((await box.run({ argv: ['cat', '-n', '/tmp/a'] })).exitCode).toBe(2);
  });

  it('cp copies one file, and reports a missing source', async () => {
    const box = await sandbox({ '/tmp/a': 'A\n' });
    expect((await box.run({ argv: ['cp', '/tmp/a', '/tmp/c/copy'] })).exitCode).toBe(0);
    expect(await box.readTextFile('/tmp/c/copy')).toBe('A\n');
    expect(await box.run({ argv: ['cp', '/tmp/none', '/tmp/x'] })).toMatchObject({
      exitCode: 1,
      stderr: "cp: cannot stat '/tmp/none': No such file or directory\n",
    });
    expect((await box.run({ argv: ['cp', '-r', '/tmp/a', '/tmp/b'] })).exitCode).toBe(2);
  });

  it('pwd prints the folder', async () => {
    expect((await (await sandbox()).run({ argv: ['pwd'], cwd: '/srv' })).stdout).toBe('/srv\n');
  });

  it('printenv prints values, and exits 1 when one is unset', async () => {
    const box = await sandbox();
    expect(await box.run({ argv: ['printenv', 'HOME', 'NOPE', 'LANG'] })).toMatchObject({
      exitCode: 1,
      stdout: '/home/user\nC\n',
    });
    expect((await box.run({ argv: ['printenv'] })).stdout).toBe('HOME=/home/user\nLANG=C\n');
  });

  it.each<[string[], string, number]>([
    [['tail', '/tmp/lines'], '1\n2\n3\n', 0],
    [['tail', '-n', '2', '/tmp/lines'], '2\n3\n', 0],
    [['tail', '-n', '0', '/tmp/lines'], '', 0],
    [['tail', '-n', '+2', '/tmp/lines'], '2\n3\n', 0],
    [['tail', '-n', '+1', '/tmp/lines'], '1\n2\n3\n', 0],
    [['tail', '/tmp/none'], '', 1],
    [['tail', '-c', '1', '/tmp/lines'], '', 2],
    [['tail', '/tmp/lines', '/tmp/lines'], '', 2],
  ])('tail %j prints %j and exits %i', async (argv, stdout, exitCode) => {
    const result = await (await sandbox({ '/tmp/lines': '1\n2\n3\n' })).run({ argv });
    expect({ stdout: result.stdout, exitCode: result.exitCode }).toEqual({ stdout, exitCode });
  });

  it('tail -f and sleep run until killed', async () => {
    const box = await sandbox({ '/tmp/lines': 'ready\n' });
    const heard: string[] = [];
    const following = await box.start({
      argv: ['tail', '-n', '+1', '-f', '/tmp/lines'],
      onStdout: (chunk) => heard.push(chunk),
    });
    const sleeping = await box.start({ argv: ['sleep', '0.5'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(heard).toEqual(['ready\n']);
    await following.kill();
    await sleeping.kill();
    expect((await following.wait()).exitCode).toBeNull();
    expect((await sleeping.wait()).exitCode).toBeNull();
    expect((await box.run({ argv: ['sleep', 'soon'] })).exitCode).toBe(2);
  });

  it('true and false exit 0 and 1', async () => {
    const box = await sandbox();
    expect((await box.run({ argv: ['true'] })).exitCode).toBe(0);
    expect((await box.run({ argv: ['false'] })).exitCode).toBe(1);
  });
});
