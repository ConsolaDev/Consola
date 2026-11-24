import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { MAX_SECRET_VALUE_BYTES } from '../secrets/values';

/**
 * The two programs a runner reads a secret's value with: macOS's `security`
 * for a keychain item and 1Password's `op` for a field. Each runs by the
 * absolute path its caller gives (never found on `PATH`), with no shell, in a
 * process group of its own and with a timeout. Its stdout is the value; its
 * stderr is drained and dropped, and nothing either prints reaches a reason or
 * a log. The value comes back raw: the engine core's `normalizeSecretValue`
 * drops the newline and applies every other check, so each runner applies
 * the same ones.
 */

/** How long a reader waits for its program: a keychain or 1Password dialog nobody answers ends here. */
export const SECRET_READ_TIMEOUT_MS = 30_000;

/** The most stdout a reader takes: the core's limit and the one newline `security -w` prints, which the core drops. */
const MAX_READ_BYTES = MAX_SECRET_VALUE_BYTES + 1;

/** Why a reader got no value, in words; never the program's output. */
export class SecretReaderFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SecretReaderFailure';
  }
}

interface ReaderInput {
  /** An absolute path; anything else is refused before a spawn. */
  program: string;
  env: NodeJS.ProcessEnv;
  /** `SECRET_READ_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
}

/** What one store's program means when it ends without a value. */
interface StoreWords {
  /** The program ended other than with 0; `how` is `exit <n>` or `signal <name>`. */
  failed(how: string, code: number | null): string;
  timedOut: string;
}

const KEYCHAIN: StoreWords = {
  failed: (how, code) =>
    code === 44 ? 'the keychain has no such item' : `\`security\` failed (${how})`,
  timedOut: 'the keychain asked for permission and nobody answered within 30 seconds',
};

const ONE_PASSWORD: StoreWords = {
  failed: (how) => `\`op\` failed (${how}); is it signed in?`,
  timedOut: '1Password asked to unlock and nobody answered within 30 seconds',
};

/** `<program> find-generic-password -s <service> -a <account> -w`: stdout as UTF-8, raw (its newline kept). */
export function readKeychainItem(
  input: ReaderInput & { service: string; account: string },
): Promise<string> {
  return readWith(
    input,
    ['find-generic-password', '-s', input.service, '-a', input.account, '-w'],
    KEYCHAIN,
  );
}

/** `<program> read --no-newline <reference>`: stdout as UTF-8, raw. */
export function readOnePasswordField(input: ReaderInput & { reference: string }): Promise<string> {
  return readWith(input, ['read', '--no-newline', input.reference], ONE_PASSWORD);
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

function readWith(input: ReaderInput, argv: string[], words: StoreWords): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const { program } = input;
    if (!path.isAbsolute(program)) {
      reject(new SecretReaderFailure(`${program} is not an absolute path`));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, argv, {
        shell: false,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      reject(new SecretReaderFailure(`${program} could not start (${codeOf(error)})`));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    /** Ends the program and everything it started: its group is its own. */
    const endGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    };
    const settle = (outcome: { value: string } | { reason: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chunks.length = 0;
      child.stdout?.destroy();
      child.stderr?.destroy();
      if ('value' in outcome) resolve(outcome.value);
      else reject(new SecretReaderFailure(outcome.reason));
    };
    /** A refusal ends the program at once, and the read with it: nothing it holds open can keep the read waiting. */
    const refuse = (reason: string): void => {
      endGroup();
      settle({ reason });
    };

    const timer = setTimeout(
      () => refuse(words.timedOut),
      input.timeoutMs ?? SECRET_READ_TIMEOUT_MS,
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_READ_BYTES) refuse('its value is over 64 KB');
      else chunks.push(chunk);
    });
    // Drained so the program never blocks on a full pipe; never read.
    child.stderr?.resume();

    child.on('error', (error) =>
      settle({ reason: `${program} could not start (${codeOf(error)})` }),
    );
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const how = code === null ? `signal ${signal}` : `exit ${code}`;
        settle({ reason: words.failed(how, code) });
        return;
      }
      let value: string;
      try {
        value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks),
        );
      } catch {
        settle({ reason: 'its value is not UTF-8 text' });
        return;
      }
      settle({ value });
    });
  });
}
