import type { SandboxProvider } from '../application/ports';
import {
  requireCapability,
  type Sandbox,
  type Sandboxes,
  sandboxesFrom,
} from '../application/sandboxes';
import type { SandboxCapability } from '../domain/capabilities';
import type { CreateSandboxOptions } from '../domain/sandbox';
import { holds, rejectsWith, same } from './expect';

/**
 * The contract every provider passes. Each check is a plain async function that throws when the
 * provider breaks a promise, so any test framework can run them, one test per check: see
 * `src/contract.test.ts`. The checks go through `sandboxesFrom`, as code does, except where a
 * promise is the provider's own (stopping twice, refusing work once stopped), which they ask of
 * the port directly. Each starts the sandboxes it needs and stops them, even when it fails.
 */

/** The programs a template must have on its PATH for the contract to run, beside a writable /tmp. */
export const CONTRACT_PROGRAMS = [
  'cat',
  'cp',
  'printenv',
  'printf',
  'pwd',
  'sleep',
  'tail',
] as const;

export interface ContractSubject {
  /** The provider under test. */
  readonly provider: SandboxProvider;
  /** A template whose sandboxes have `CONTRACT_PROGRAMS` and a writable /tmp. */
  readonly template: string;
  /**
   * Lets `seconds` of the provider's time pass, for the checks about lifetimes: a real
   * provider's subject waits that long, the fake's moves the fake's clock (`elapse`).
   */
  readonly elapse: (seconds: number) => Promise<void>;
}

export interface ContractCheck {
  /** What a provider does, worded to follow its name: "creates sandboxes from a template, …". */
  readonly name: string;
  /** The capability the check is about. A provider without it skips the check. */
  readonly needs?: SandboxCapability;
  run(subject: ContractSubject): Promise<void>;
}

/** Where checks keep the files they write. */
const DIR = '/tmp/consola-contract';

/**
 * The lifetime the lifetime checks give a sandbox, and how long they then let pass for it to
 * run out: long enough for a real provider to start a sandbox and use it before then, and to
 * stop it on time after. A provider is held to stopping it within the margin between the two.
 */
const LIFETIME = 10;
const PAST_LIFETIME = 15;

interface Scene {
  readonly sandboxes: Sandboxes;
  readonly template: string;
  readonly elapse: ContractSubject['elapse'];
  /** A second sandbox of the same template, stopped when `use` settles. */
  another(use: (sandbox: Sandbox) => Promise<void>): Promise<void>;
}

/** A check that runs `body` in a fresh sandbox, created with `options`. */
function inSandbox(
  body: (sandbox: Sandbox, scene: Scene) => Promise<void>,
  options: Omit<CreateSandboxOptions, 'template'> = {},
): ContractCheck['run'] {
  return async ({ provider, template, elapse }) => {
    const sandboxes = sandboxesFrom(provider);
    const scene: Scene = {
      sandboxes,
      template,
      elapse,
      another: (use) => sandboxes.withSandbox({ template }, use),
    };
    await sandboxes.withSandbox({ template, ...options }, (sandbox) => body(sandbox, scene));
  };
}

const MISSING_FILE = `${DIR}/no-such-file`;
const NO_SUCH_SANDBOX = 'consola-contract-no-such-sandbox';

export const sandboxContract: readonly ContractCheck[] = [
  {
    name: 'creates sandboxes from a template, each with an id of its own',
    run: inSandbox(async (first, scene) => {
      holds(first.id.trim() !== '', 'A sandbox has an id.');
      await scene.another(async (second) => {
        holds(second.id !== first.id, `Two sandboxes share the id ${first.id}.`);
      });
    }),
  },
  {
    name: 'refuses a template it does not have, as not-found',
    run: async ({ provider }) => {
      await rejectsWith(
        async () => {
          const made = await sandboxesFrom(provider).create({
            template: 'consola-contract-no-such-template',
          });
          await made.stop();
        },
        'not-found',
        'Creating a sandbox from a template that does not exist',
      );
    },
  },
  {
    name: "keeps each sandbox's files to itself",
    run: inSandbox(async (first, scene) => {
      await first.writeFile(`${DIR}/mine.txt`, 'first\n');
      await scene.another(async (second) => {
        await rejectsWith(
          () => second.readFile(`${DIR}/mine.txt`),
          'not-found',
          "Reading another sandbox's file",
        );
      });
    }),
  },
  {
    name: 'runs a command to its end, with its output and exit code',
    run: inSandbox(async (sandbox) => {
      const result = await sandbox.run({ argv: ['printf', '%s\n', 'hello'] });
      same(result, { exitCode: 0, stdout: 'hello\n', stderr: '' }, 'printf %s\\n hello');
    }),
  },
  {
    name: 'hands each argument to the program as it is, with no shell between',
    run: inSandbox(async (sandbox) => {
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
        '',
      ];
      const result = await sandbox.run({ argv: ['printf', '%s|', ...args] });
      same(
        result.stdout,
        args.map((arg) => `${arg}|`).join(''),
        'Arguments as the program saw them',
      );
    }),
  },
  {
    name: 'reports a failing exit code as a result, never as an error',
    run: inSandbox(async (sandbox) => {
      const result = await sandbox.run({ argv: ['cat', MISSING_FILE] });
      holds(
        result.exitCode !== null && result.exitCode > 0,
        `cat of a missing file exited with ${result.exitCode}.`,
      );
      holds(result.stderr !== '', 'cat of a missing file said nothing on stderr.');
      same(result.stdout, '', 'stdout of cat on a missing file');
    }),
  },
  {
    name: 'ends a program that is not there with exit code 127',
    run: inSandbox(async (sandbox) => {
      const result = await sandbox.run({ argv: ['consola-contract-no-such-program'] });
      same(result.exitCode, 127, 'The exit code of a program that does not exist');
    }),
  },
  {
    name: "gives every command the sandbox's variables, and a command's own on top",
    run: inSandbox(
      async (sandbox) => {
        const fromSandbox = await sandbox.run({ argv: ['printenv', 'CONSOLA_CONTRACT_SANDBOX'] });
        same(fromSandbox.stdout, 'from the sandbox\n', "A sandbox's variable");

        const onTop = await sandbox.run({
          argv: ['printenv', 'CONSOLA_CONTRACT_BOTH'],
          env: { CONSOLA_CONTRACT_BOTH: 'from the command', CONSOLA_CONTRACT_COMMAND: 'once' },
        });
        same(onTop.stdout, 'from the command\n', "A command's variable over the sandbox's");

        const after = await sandbox.run({
          argv: ['printenv', 'CONSOLA_CONTRACT_BOTH', 'CONSOLA_CONTRACT_COMMAND'],
        });
        same(after.stdout, 'from the sandbox\n', "The next command's variables");
        same(after.exitCode, 1, "printenv's exit code, once the command's own variable is gone");
      },
      {
        env: {
          CONSOLA_CONTRACT_SANDBOX: 'from the sandbox',
          CONSOLA_CONTRACT_BOTH: 'from the sandbox',
        },
      },
    ),
  },
  {
    name: 'runs a command in the folder it names',
    run: inSandbox(async (sandbox) => {
      await sandbox.writeFile(`${DIR}/folder/marker`, '');
      const result = await sandbox.run({ argv: ['pwd'], cwd: `${DIR}/folder` });
      same(result.stdout, `${DIR}/folder\n`, 'pwd in the folder a command names');
    }),
  },
  {
    name: 'streams output to the listeners, all of it before the result',
    run: inSandbox(async (sandbox) => {
      const out: string[] = [];
      const result = await sandbox.run({
        argv: ['printf', '%s\n', 'one', 'two', 'three'],
        onStdout: (chunk) => out.push(chunk),
      });
      same(out.join(''), 'one\ntwo\nthree\n', 'What the stdout listener heard');
      same(result.stdout, 'one\ntwo\nthree\n', 'The stdout in the result');

      const err: string[] = [];
      const failed = await sandbox.run({
        argv: ['cat', MISSING_FILE],
        onStderr: (chunk) => err.push(chunk),
      });
      holds(err.join('') !== '', 'The stderr listener heard nothing from a failing cat.');
      same(err.join(''), failed.stderr, 'What the stderr listener heard, against the result');
    }),
  },
  {
    name: 'streams output while the command still runs',
    run: inSandbox(async (sandbox) => {
      const path = `${DIR}/stream.txt`;
      await sandbox.writeFile(path, 'ready\n');
      let heard = '';
      let onReady = (): void => undefined;
      const ready = new Promise<'output'>((resolve) => {
        onReady = () => resolve('output');
      });
      const running = await sandbox.start({
        argv: ['tail', '-n', '+1', '-f', path],
        onStdout: (chunk) => {
          heard += chunk;
          if (heard.includes('ready\n')) onReady();
        },
      });
      const first = await Promise.race([ready, running.wait().then(() => 'ended' as const)]);
      holds(first === 'output', 'tail -f ended before any of its output arrived.');
      await running.kill();
      const result = await running.wait();
      same(result.exitCode, null, 'The exit code of a killed tail -f');
      holds(
        result.stdout.includes('ready\n'),
        'The result lost the output streamed before the kill.',
      );
    }),
  },
  {
    name: 'kills a command, which then ends with no exit code, and runs others meanwhile',
    run: inSandbox(async (sandbox) => {
      const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
      const beside = await sandbox.run({ argv: ['printf', '%s', 'beside'] });
      same(beside.stdout, 'beside', 'A command run beside a running one');
      await sleeping.kill();
      same((await sleeping.wait()).exitCode, null, 'The exit code of a killed sleep');
      await sleeping.kill();
    }),
  },
  {
    name: 'reads back what it writes, as text and as bytes',
    run: inSandbox(async (sandbox) => {
      await sandbox.writeFile(`${DIR}/text.txt`, 'héllo ✓\n');
      same(await sandbox.readTextFile(`${DIR}/text.txt`), 'héllo ✓\n', 'Text read back');

      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      await sandbox.writeFile(`${DIR}/bytes.bin`, bytes);
      same(await sandbox.readFile(`${DIR}/bytes.bin`), bytes, 'Every byte value read back');
    }),
  },
  {
    name: 'creates missing folders when it writes, and replaces a file that is there',
    run: inSandbox(async (sandbox) => {
      const path = `${DIR}/a/b/c/nested.txt`;
      await sandbox.writeFile(path, 'a longer first version\n');
      await sandbox.writeFile(path, 'short\n');
      same(await sandbox.readTextFile(path), 'short\n', 'A file written twice');
    }),
  },
  {
    name: 'refuses to read a file that is not there, as not-found',
    run: inSandbox(async (sandbox) => {
      await rejectsWith(
        () => sandbox.readFile(MISSING_FILE),
        'not-found',
        'Reading a missing file',
      );
    }),
  },
  {
    name: 'shares files between the file calls and commands',
    run: inSandbox(async (sandbox) => {
      await sandbox.writeFile(`${DIR}/shared.txt`, 'shared\n');
      const read = await sandbox.run({ argv: ['cat', `${DIR}/shared.txt`] });
      same(read.stdout, 'shared\n', 'cat of a file written by writeFile');

      const copied = await sandbox.run({ argv: ['cp', `${DIR}/shared.txt`, `${DIR}/copy.txt`] });
      same(copied.exitCode, 0, "cp's exit code");
      same(await sandbox.readTextFile(`${DIR}/copy.txt`), 'shared\n', 'A file a command wrote');
    }),
  },
  {
    name: 'exposes each port at an address of its own',
    run: inSandbox(async (sandbox, scene) => {
      const first = await sandbox.exposePort(7420);
      same(first.port, 7420, 'The exposed port');
      holds(/^https?:\/\//.test(first.url), `${first.url} is no http or https address.`);
      holds(first.url.includes(first.host), `${first.url} does not name its host ${first.host}.`);

      const again = await sandbox.exposePort(7420);
      same(again.url, first.url, 'The same port exposed twice');
      const other = await sandbox.exposePort(7421);
      holds(other.url !== first.url, `Ports 7420 and 7421 share the address ${first.url}.`);

      await scene.another(async (second) => {
        const theirs = await second.exposePort(7420);
        holds(theirs.url !== first.url, `Two sandboxes expose port 7420 at ${first.url}.`);
      });
    }),
  },
  {
    name: 'ends its running commands when it stops',
    run: async ({ provider, template }) => {
      const sandbox = await sandboxesFrom(provider).create({ template });
      try {
        const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
        await sandbox.stop();
        same((await sleeping.wait()).exitCode, null, 'A command running when its sandbox stopped');
      } finally {
        await sandbox.stop();
      }
    },
  },
  {
    name: 'stops once however often asked, and then refuses work as not-running',
    run: async ({ provider, template }) => {
      // The provider's own promises, asked of the port: a sandbox can be stopped from
      // elsewhere (another handle, a timeout), and no guard in front of it would know.
      const sandbox = await provider.create({ template });
      await sandbox.stop();
      await sandbox.stop();
      const what = 'A stopped sandbox, asked directly';
      await rejectsWith(() => sandbox.start({ argv: ['true'] }), 'not-running', `${what} to run`);
      await rejectsWith(() => sandbox.readFile(MISSING_FILE), 'not-running', `${what} to read`);
      await rejectsWith(
        () => sandbox.writeFile(`${DIR}/late.txt`, new Uint8Array()),
        'not-running',
        `${what} to write`,
      );
      await rejectsWith(() => sandbox.exposePort(7420), 'not-running', `${what} to expose`);
    },
  },
  {
    name: 'stops a sandbox on its own once its lifetime runs out, ending its commands',
    run: inSandbox(
      async (sandbox, { sandboxes, elapse }) => {
        const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
        await elapse(PAST_LIFETIME);
        // Asked before waiting: a sandbox that outlived its lifetime would keep `sleep` running.
        await rejectsWith(
          () => sandbox.run({ argv: ['true'] }),
          'not-running',
          'A sandbox whose lifetime ran out, asked to run',
        );
        await rejectsWith(
          () => sandboxes.attach(sandbox.id),
          'not-found',
          'Attaching to a sandbox whose lifetime ran out',
        );
        same((await sleeping.wait()).exitCode, null, 'A command running when its lifetime ran out');
      },
      { lifetimeSeconds: LIFETIME },
    ),
  },
  {
    name: 'attaches to a running sandbox by its id, and leaves its lifetime as it was',
    run: inSandbox(
      async (sandbox, { sandboxes, elapse }) => {
        await sandbox.writeFile(`${DIR}/attached.txt`, 'attached\n');
        const attached = await sandboxes.attach(sandbox.id);
        same(attached.id, sandbox.id, 'The id of the sandbox attached to');
        same(
          await attached.readTextFile(`${DIR}/attached.txt`),
          'attached\n',
          'A file read through the attached handle',
        );
        same(
          (await attached.run({ argv: ['printf', 'here'] })).stdout,
          'here',
          'A command run through the attached handle',
        );
        await elapse(PAST_LIFETIME);
        await rejectsWith(
          () => attached.run({ argv: ['true'] }),
          'not-running',
          'An attached sandbox once the lifetime it was created with ran out',
        );
      },
      { lifetimeSeconds: LIFETIME },
    ),
  },
  {
    name: 'refuses to attach to a sandbox that is not there, or has stopped, as not-found',
    run: async ({ provider, template }) => {
      const sandboxes = sandboxesFrom(provider);
      await rejectsWith(
        () => sandboxes.attach(NO_SUCH_SANDBOX),
        'not-found',
        'Attaching to a sandbox that does not exist',
      );
      const stopped = await sandboxes.create({ template });
      await stopped.stop();
      await rejectsWith(
        async () => {
          const attached = await sandboxes.attach(stopped.id);
          await attached.stop();
        },
        'not-found',
        'Attaching to a sandbox that has stopped',
      );
    },
  },
  {
    name: 'stops a sandbox by its id from anywhere, ending its commands, however often asked',
    run: async ({ provider, template }) => {
      const sandboxes = sandboxesFrom(provider);
      const sandbox = await sandboxes.create({ template });
      try {
        const sleeping = await sandbox.start({ argv: ['sleep', '600'] });
        await sandboxes.stop(sandbox.id);
        // Asked before waiting: a sandbox left running would keep `sleep` running.
        await rejectsWith(
          () => sandbox.run({ argv: ['true'] }),
          'not-running',
          'A sandbox stopped by its id, asked to run through a handle on it',
        );
        await rejectsWith(
          () => sandboxes.attach(sandbox.id),
          'not-found',
          'Attaching to a sandbox stopped by its id',
        );
        same(
          (await sleeping.wait()).exitCode,
          null,
          'A command running when its sandbox was stopped by its id',
        );
        await sandboxes.stop(sandbox.id);
        await sandboxes.stop(NO_SUCH_SANDBOX);
      } finally {
        await sandbox.stop();
      }
    },
  },
  {
    name: 'pauses a sandbox, and resumes it by its id with its files',
    needs: 'pausing',
    run: inSandbox(async (sandbox, { sandboxes }) => {
      const pausing = requireCapability(sandboxes, 'pausing');
      await sandbox.writeFile(`${DIR}/kept.txt`, 'kept\n');
      await pausing.pause(sandbox);
      await rejectsWith(
        () => sandbox.run({ argv: ['true'] }),
        'not-running',
        'A paused sandbox asked to run',
      );
      const resumed = await pausing.resume(sandbox.id);
      try {
        same(resumed.id, sandbox.id, 'The id of the resumed sandbox');
        same(await resumed.readTextFile(`${DIR}/kept.txt`), 'kept\n', 'A file kept over the pause');
        same((await resumed.run({ argv: ['printf', 'awake'] })).stdout, 'awake', 'After resuming');
      } finally {
        await resumed.stop();
      }
    }),
  },
  {
    name: 'refuses to resume a sandbox that is not there, or has stopped, as not-found',
    needs: 'pausing',
    run: async ({ provider, template }) => {
      const sandboxes = sandboxesFrom(provider);
      const pausing = requireCapability(sandboxes, 'pausing');
      await rejectsWith(
        () => pausing.resume('consola-contract-no-such-sandbox'),
        'not-found',
        'Resuming a sandbox that does not exist',
      );
      const stopped = await sandboxes.create({ template });
      await stopped.stop();
      await rejectsWith(
        async () => {
          const resumed = await pausing.resume(stopped.id);
          await resumed.stop();
        },
        'not-found',
        'Resuming a sandbox that has stopped',
      );
    },
  },
  {
    name: 'saves a snapshot that new sandboxes start from, and keeps running',
    needs: 'snapshots',
    run: inSandbox(async (sandbox, { sandboxes }) => {
      const snapshots = requireCapability(sandboxes, 'snapshots');
      await sandbox.writeFile(`${DIR}/saved.txt`, 'saved\n');
      const template = await snapshots.snapshot(sandbox);
      try {
        await sandboxes.withSandbox({ template }, async (fromSnapshot) => {
          same(
            await fromSnapshot.readTextFile(`${DIR}/saved.txt`),
            'saved\n',
            'A file in a sandbox started from the snapshot',
          );
        });
        same(
          (await sandbox.run({ argv: ['printf', 'still'] })).stdout,
          'still',
          'After a snapshot',
        );
      } finally {
        await snapshots.remove(template);
      }
    }),
  },
  {
    name: 'removes a snapshot, which no sandbox then starts from',
    needs: 'snapshots',
    run: inSandbox(async (sandbox, { sandboxes }) => {
      const snapshots = requireCapability(sandboxes, 'snapshots');
      const template = await snapshots.snapshot(sandbox);
      await snapshots.remove(template);
      await rejectsWith(
        async () => {
          const made = await sandboxes.create({ template });
          await made.stop();
        },
        'not-found',
        'Creating a sandbox from a removed snapshot',
      );
      await snapshots.remove(template);
    }),
  },
  {
    name: "renews a sandbox's lifetime from now, longer or shorter, until it has run out",
    needs: 'keepAlive',
    run: inSandbox(
      async (sandbox, { sandboxes, elapse }) => {
        const keepAlive = requireCapability(sandboxes, 'keepAlive');
        await keepAlive.renew(sandbox, LIFETIME * 6);
        await elapse(PAST_LIFETIME);
        same(
          (await sandbox.run({ argv: ['printf', 'alive'] })).stdout,
          'alive',
          'A sandbox renewed past the lifetime it was created with',
        );
        await keepAlive.renew(sandbox, LIFETIME);
        await elapse(PAST_LIFETIME);
        await rejectsWith(
          () => sandbox.run({ argv: ['true'] }),
          'not-running',
          'A sandbox renewed for less, once that ran out',
        );
        await rejectsWith(
          () => keepAlive.renew(sandbox, LIFETIME),
          'not-running',
          'Renewing a sandbox whose lifetime ran out',
        );
      },
      { lifetimeSeconds: LIFETIME },
    ),
  },
];
