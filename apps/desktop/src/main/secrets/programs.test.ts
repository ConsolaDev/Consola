import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findOnPath, isExecutableFile, KEYCHAIN_PROGRAM, secretPrograms } from './programs';

/*
 * Nothing here spawns: a program is a path the readers would be handed, and
 * the test reads it as a string. Rule 5a-secrets: in a test run the answer is
 * a stub's path or nothing, never `/usr/bin/security`.
 */

const yes = () => true;

describe('secretPrograms outside a test run', () => {
  it('names the keychain program by its absolute path, and 1Password by the path a binding kept', () => {
    const programs = secretPrograms({ test: false, env: {} });
    expect(KEYCHAIN_PROGRAM).toBe('/usr/bin/security');
    expect(programs.keychain).toBe('/usr/bin/security');
    expect(programs.onePassword('/opt/homebrew/bin/op')).toBe('/opt/homebrew/bin/op');
    expect(programs.onePassword(undefined)).toBeNull();
  });

  it('finds op on the login PATH it is given, never on its own', () => {
    const programs = secretPrograms({
      test: false,
      env: { PATH: '/opt/homebrew/bin' },
      isExecutable: (file) => file === '/usr/local/bin/op',
    });
    expect(programs.findOnePassword('/usr/bin:/usr/local/bin')).toBe('/usr/local/bin/op');
    expect(programs.findOnePassword('/opt/homebrew/bin')).toBeNull();
    expect(programs.findOnePassword(undefined)).toBeNull();
  });

  it('ignores the stubs a test run would use', () => {
    const programs = secretPrograms({
      test: false,
      env: { CONSOLA_E2E_SECURITY: '/stub/security', CONSOLA_E2E_OP: '/stub/op' },
    });
    expect(programs.keychain).toBe('/usr/bin/security');
    expect(programs.onePassword('/opt/homebrew/bin/op')).toBe('/opt/homebrew/bin/op');
  });
});

describe('secretPrograms in a test run', () => {
  it('names no program without a stub, whatever a binding kept or PATH holds', () => {
    const programs = secretPrograms({ test: true, env: {}, isExecutable: yes });
    expect(programs.keychain).toBeNull();
    expect(programs.onePassword('/opt/homebrew/bin/op')).toBeNull();
    expect(programs.onePassword(undefined)).toBeNull();
    expect(programs.findOnePassword('/opt/homebrew/bin')).toBeNull();
  });

  it('names the stubs it is given', () => {
    const programs = secretPrograms({
      test: true,
      env: { CONSOLA_E2E_SECURITY: '/stub/security', CONSOLA_E2E_OP: '/stub/op' },
      isExecutable: yes,
    });
    expect(programs.keychain).toBe('/stub/security');
    expect(programs.onePassword('/opt/homebrew/bin/op')).toBe('/stub/op');
    expect(programs.onePassword(undefined)).toBe('/stub/op');
    expect(programs.findOnePassword('/opt/homebrew/bin')).toBe('/stub/op');
  });

  it('reads an empty stub variable as no stub', () => {
    const programs = secretPrograms({
      test: true,
      env: { CONSOLA_E2E_SECURITY: '', CONSOLA_E2E_OP: '' },
    });
    expect(programs.keychain).toBeNull();
    expect(programs.onePassword(undefined)).toBeNull();
  });

  describe('with no argument (review M7)', () => {
    const saved = process.env.CONSOLA_E2E_SECURITY;
    afterEach(() => {
      if (saved === undefined) delete process.env.CONSOLA_E2E_SECURITY;
      else process.env.CONSOLA_E2E_SECURITY = saved;
    });

    it('is a test run inside this unit run, so it never names the real keychain program', () => {
      expect(process.env.NODE_ENV).toBe('test');
      delete process.env.CONSOLA_E2E_SECURITY;
      expect(secretPrograms().keychain).toBeNull();
      process.env.CONSOLA_E2E_SECURITY = '/stub/security';
      expect(secretPrograms().keychain).toBe('/stub/security');
    });
  });
});

describe('findOnPath', () => {
  it('returns the first executable entry, skipping empty and relative segments', () => {
    const exec = (file: string) => file === '/b/op' || file === 'rel/op';
    expect(findOnPath('op', '/a::/b', exec)).toBe('/b/op');
    expect(findOnPath('op', 'rel:/b', exec)).toBe('/b/op');
    expect(findOnPath('op', '/a', exec)).toBeNull();
    expect(findOnPath('op', '', exec)).toBeNull();
    expect(findOnPath('op', undefined, exec)).toBeNull();
  });

  describe('on the disk', () => {
    let dir: string;
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('skips a directory named op and a file it cannot run', () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-find-op-'));
      const [a, b, c] = ['a', 'b', 'c'].map((name) => path.join(dir, name));
      for (const folder of [a, b, c]) fs.mkdirSync(folder);
      fs.mkdirSync(path.join(a, 'op'));
      fs.writeFileSync(path.join(b, 'op'), '#!/bin/sh\n', { mode: 0o644 });
      fs.writeFileSync(path.join(c, 'op'), '#!/bin/sh\n', { mode: 0o755 });
      expect(findOnPath('op', `${a}::${b}:${c}`, isExecutableFile)).toBe(path.join(c, 'op'));
      expect(findOnPath('op', `${a}:${b}`, isExecutableFile)).toBeNull();
    });
  });
});
