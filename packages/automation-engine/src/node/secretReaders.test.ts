import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SECRET_VALUE_BYTES } from '../secrets/values';
import {
  SECRET_READ_TIMEOUT_MS,
  SecretReaderFailure,
  readKeychainItem,
  readOnePasswordField,
} from './secretReaders';

/*
 * Every program here is a fake `#!/bin/sh` script in a fresh temp folder,
 * named by its absolute path. The environment's PATH is `/bin`, so no real
 * `security` or `op` is reachable from a fake or from the reader.
 */

const ENV: NodeJS.ProcessEnv = { PATH: '/bin' };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-secret-readers-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A fake that logs each argument on its own line and prints `print`. */
function logging(name: string, print: string): { program: string; log: string } {
  const log = path.join(dir, `${name}.log`);
  return { program: fake(name, `printf '%s\\n' "$@" > '${log}'\nprintf '%s' '${print}'`), log };
}

/** A fake that prints the bytes of a file the test wrote. */
function printing(name: string, bytes: Buffer): string {
  const data = path.join(dir, `${name}.data`);
  fs.writeFileSync(data, bytes);
  return fake(name, `/bin/cat '${data}'`);
}

async function failureOf(promise: Promise<unknown>): Promise<SecretReaderFailure> {
  const error = await promise.then(
    () => {
      throw new Error('the read resolved');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SecretReaderFailure);
  return error as SecretReaderFailure;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('readKeychainItem', () => {
  it('runs the program it is given with the keychain argv, exactly, and returns stdout raw', async () => {
    const { program, log } = logging('fake-security', 'stub-keychain-secret-1\n');
    const value = await readKeychainItem({
      program,
      env: ENV,
      service: 'consola/ws-1/personal',
      account: 'PAGER_TOKEN',
    });
    expect(value).toBe('stub-keychain-secret-1\n');
    expect(fs.readFileSync(log, 'utf8')).toBe(
      ['find-generic-password', '-s', 'consola/ws-1/personal', '-a', 'PAGER_TOKEN', '-w', ''].join(
        '\n',
      ),
    );
  });

  it('passes every argument as itself, with no shell to read it', async () => {
    const { program, log } = logging('fake-security', 'stub-keychain-secret-1\n');
    const pwned = path.join(dir, 'pwned');
    // An absolute `touch`, since the PATH is `/bin`: a shell would run it.
    const account = `$(/usr/bin/touch ${pwned})`;
    await readKeychainItem({ program, env: ENV, service: 'consola/ws-1/personal', account });
    expect(fs.readFileSync(log, 'utf8').split('\n')[4]).toBe(account);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it('keeps a byte-order mark the value starts with', async () => {
    const program = printing('fake-security', Buffer.from('﻿stub-keychain-secret-2\n'));
    await expect(readKeychainItem({ program, env: ENV, service: 's', account: 'a' })).resolves.toBe(
      '﻿stub-keychain-secret-2\n',
    );
  });

  it('names no output when it fails, on either stream', async () => {
    const program = fake(
      'fake-security',
      "printf 'stub-leaked-value-123'\nprintf 'stub-leaked-value-123' >&2\nexit 1",
    );
    const failure = await failureOf(
      readKeychainItem({ program, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('`security` failed (exit 1)');
    expect(failure.reason).not.toContain('stub-leaked');
    expect(String(failure)).not.toContain('stub-leaked');
    expect(failure.message).not.toContain('stub-leaked');
  });

  it('says which signal ended the program', async () => {
    const program = fake('fake-security', 'kill -TERM $$');
    const failure = await failureOf(
      readKeychainItem({ program, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('`security` failed (signal SIGTERM)');
  });

  it('says the keychain has no such item when security exits 44', async () => {
    const program = fake(
      'fake-security',
      "printf 'security: SecKeychainSearchCopyNext' >&2\nexit 44",
    );
    const failure = await failureOf(
      readKeychainItem({ program, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('the keychain has no such item');
  });

  it('gives up after its timeout and ends everything the program started (Review Focus 2)', async () => {
    const pids = path.join(dir, 'pids');
    const program = fake(
      'fake-security',
      `/bin/sleep 30 &\necho "$$ $!" > '${pids}'\n/bin/sleep 30`,
    );
    const started = Date.now();
    const failure = await failureOf(
      readKeychainItem({ program, env: ENV, service: 's', account: 'a', timeoutMs: 300 }),
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failure.reason).toBe(
      'the keychain asked for permission and nobody answered within 30 seconds',
    );
    const [shell, grandchild] = fs.readFileSync(pids, 'utf8').trim().split(' ').map(Number);
    expect(shell).toBeGreaterThan(0);
    expect(grandchild).toBeGreaterThan(0);
    // An ended process can stay in the table a moment, until its parent reaps it.
    await vi.waitFor(() => {
      expect(alive(shell)).toBe(false);
      expect(alive(grandchild)).toBe(false);
    });
  });

  it('takes 64 KB and the newline security prints, and refuses one byte more', async () => {
    const fits = Buffer.concat([Buffer.alloc(MAX_SECRET_VALUE_BYTES, 'a'), Buffer.from('\n')]);
    expect(fits.length).toBe(65_537);
    const program = printing('fake-security', fits);
    await expect(readKeychainItem({ program, env: ENV, service: 's', account: 'a' })).resolves.toBe(
      fits.toString('utf8'),
    );

    const over = printing(
      'fake-security-over',
      Buffer.concat([Buffer.alloc(MAX_SECRET_VALUE_BYTES + 1, 'a'), Buffer.from('\n')]),
    );
    const failure = await failureOf(
      readKeychainItem({ program: over, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('its value is over 64 KB');
  });

  it('refuses a value that is not UTF-8 text', async () => {
    const program = printing('fake-security', Buffer.from([0xff, 0xfe]));
    const failure = await failureOf(
      readKeychainItem({ program, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('its value is not UTF-8 text');
  });

  it('refuses a program that is not an absolute path, before anything starts', async () => {
    const failure = await failureOf(
      readKeychainItem({ program: './fake-security', env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe('./fake-security is not an absolute path');
  });

  it('says a missing program could not start', async () => {
    const missing = path.join(dir, 'no-such-security');
    const failure = await failureOf(
      readKeychainItem({ program: missing, env: ENV, service: 's', account: 'a' }),
    );
    expect(failure.reason).toBe(`${missing} could not start (ENOENT)`);
  });

  it('waits 30 seconds by default', () => {
    expect(SECRET_READ_TIMEOUT_MS).toBe(30_000);
  });
});

describe('readOnePasswordField', () => {
  it('runs the program it is given with `read --no-newline <reference>`, exactly', async () => {
    const { program, log } = logging('fake-op', 'stub-op-secret-1');
    const value = await readOnePasswordField({
      program,
      env: ENV,
      reference: 'op://Ops/PagerDuty/credential',
    });
    expect(value).toBe('stub-op-secret-1');
    expect(fs.readFileSync(log, 'utf8')).toBe(
      ['read', '--no-newline', 'op://Ops/PagerDuty/credential', ''].join('\n'),
    );
  });

  it('asks whether op is signed in when it fails, naming no output', async () => {
    const program = fake(
      'fake-op',
      "printf 'stub-leaked-value-123'\nprintf 'stub-leaked-value-123' >&2\nexit 1",
    );
    const failure = await failureOf(
      readOnePasswordField({ program, env: ENV, reference: 'op://Ops/PagerDuty/credential' }),
    );
    expect(failure.reason).toBe('`op` failed (exit 1); is it signed in?');
    expect(String(failure)).not.toContain('stub-leaked');
  });

  it('says 1Password asked to unlock when nobody answered in time', async () => {
    const program = fake('fake-op', '/bin/sleep 30');
    const failure = await failureOf(
      readOnePasswordField({
        program,
        env: ENV,
        reference: 'op://Ops/PagerDuty/credential',
        timeoutMs: 300,
      }),
    );
    expect(failure.reason).toBe('1Password asked to unlock and nobody answered within 30 seconds');
  });

  it('refuses a program that is not an absolute path', async () => {
    const failure = await failureOf(
      readOnePasswordField({ program: 'op', env: ENV, reference: 'op://Ops/PagerDuty/credential' }),
    );
    expect(failure.reason).toBe('op is not an absolute path');
  });
});
