import { describe, expect, it } from 'vitest';
import type { Command } from './sandbox';
import {
  commandProblem,
  createOptionsProblem,
  envProblem,
  exitCodeProblem,
  exposedUrlProblem,
  lifetimeProblem,
  nameProblem,
  pathProblem,
  portProblem,
  sandboxIdProblem,
} from './rules';

describe('the request rules', () => {
  it.each([
    [{ template: 'base' }, null],
    [{ template: 'base', env: { CI: '1' } }, null],
    [{ template: '' }, /template/],
    [{ template: '   ' }, /template/],
    [{ template: 7 }, /template/],
    [null, /template/],
    [{ template: 'base', env: { '1X': 'a' } }, /not a variable name/],
    [{ template: 'base', lifetimeSeconds: 3600 }, null],
    [{ template: 'base', lifetimeSeconds: 0 }, /lifetime/],
    [{ template: 'base', lifetimeSeconds: '60' }, /lifetime/],
    [{ template: 'base', publicPorts: true }, null],
    [{ template: 'base', publicPorts: false }, null],
    [{ template: 'base', publicPorts: 'yes' }, /public ports/],
  ])('create options %j: %s', (options, problem) => {
    const found = createOptionsProblem(options as never);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });

  it.each([
    [undefined, null],
    [{}, null],
    [{ PATH: '/bin', _under: 'x', A1: '' }, null],
    [[], /object/],
    [null, /object/],
    [{ 'A-B': 'x' }, /not a variable name/],
    [{ 'A B': 'x' }, /not a variable name/],
    [{ '': 'x' }, /not a variable name/],
    [{ A: 1 }, /string value/],
    [{ A: 'a\u0000b' }, /NUL/],
  ])('env %j: %s', (env, problem) => {
    const found = envProblem(env);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });

  const listener = () => undefined;
  it.each<[unknown, RegExp | null]>([
    [{ argv: ['printf', 'x'] }, null],
    [{ argv: ['sh', '-c', 'echo $HOME'], cwd: '/tmp', env: { A: 'b' }, onStdout: listener }, null],
    [{ argv: ['printf', ''] }, null],
    [{ argv: [] }, /program to run/],
    [{ argv: [''] }, /program to run/],
    [{ argv: 'printf x' }, /program to run/],
    [null, /program to run/],
    [{ argv: ['printf', 3] }, /Argument 1 is not a string/],
    [{ argv: ['printf', 'a\u0000'] }, /Argument 1 holds a NUL/],
    [{ argv: ['pwd'], cwd: 'relative' }, /folder.*absolute/],
    [{ argv: ['pwd'], env: { 'NOT OK': 'x' } }, /not a variable name/],
    [{ argv: ['pwd'], onStderr: 'loud' }, /onStderr is not a function/],
    [{ argv: ['pwd'], keepOutput: false }, null],
    [{ argv: ['pwd'], keepOutput: 'no' }, /keepOutput is true or false/],
  ])('command %j: %s', (command, problem) => {
    const found = commandProblem(command as Command);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });

  it.each([
    ['/tmp/a.txt', null],
    ['/', null],
    ['tmp/a.txt', /absolute/],
    ['', /absolute/],
    [undefined, /absolute/],
    ['/tmp/a\u0000', /NUL/],
  ])('path %j: %s', (path, problem) => {
    const found = pathProblem(path);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });

  it.each([
    [1, true],
    [7420, true],
    [65535, true],
    [0, false],
    [65536, false],
    [-1, false],
    [80.5, false],
    ['80', false],
    [Number.NaN, false],
  ])('port %j is a port: %s', (port, valid) => {
    expect(portProblem(port) === null).toBe(valid);
  });

  it.each([
    [1, true],
    [300, true],
    [86_400, true],
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NaN, false],
    [2 ** 60, false],
    ['60', false],
    [undefined, false],
  ])('lifetime %j is one: %s', (lifetime, valid) => {
    expect(lifetimeProblem(lifetime) === null).toBe(valid);
  });

  it.each([
    ['sbx-1', null],
    ['', /Attaching needs the id of a sandbox/],
    ['   ', /Attaching needs the id/],
    [7, /Attaching needs the id/],
    [undefined, /Attaching needs the id/],
  ])('sandbox id %j: %s', (sandboxId, problem) => {
    const found = sandboxIdProblem('Attaching', sandboxId);
    if (problem === null) expect(found).toBeNull();
    else expect(found).toMatch(problem);
  });
});

describe('the answer rules', () => {
  it.each([
    [0, true],
    [127, true],
    [null, true],
    [-1, false],
    [1.5, false],
    [undefined, false],
    ['0', false],
  ])('exit code %j is one: %s', (exitCode, valid) => {
    expect(exitCodeProblem(exitCode) === null).toBe(valid);
  });

  it.each([
    ['https://7420-abc.e2b.app', true],
    ['http://localhost:7420', true],
    ['https://7420-abc.e2b.app/path', true],
    ['wss://7420-abc.e2b.app', false],
    ['ftp://files.test', false],
    ['7420-abc.e2b.app', false],
    ['', false],
    [undefined, false],
  ])('exposed address %j is one: %s', (url, valid) => {
    expect(exposedUrlProblem(url) === null).toBe(valid);
  });

  it.each([
    ['sbx-1', true],
    ['', false],
    ['  ', false],
    [42, false],
  ])('name %j is one: %s', (name, valid) => {
    expect(nameProblem('an id', name) === null).toBe(valid);
  });
});
