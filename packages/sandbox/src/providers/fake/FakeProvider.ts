import type {
  ProviderCommand,
  ProviderPausing,
  ProviderSandbox,
  ProviderSnapshots,
  SandboxProvider,
} from '../../application/ports';
import { SANDBOX_CAPABILITIES, type SandboxCapability } from '../../domain/capabilities';
import { asSandboxError, SandboxError } from '../../domain/errors';
import type { Command, CreateSandboxOptions } from '../../domain/sandbox';
import { resolvePath } from './paths';

/**
 * An in-memory provider for tests. It keeps every sandbox's files in memory and runs commands
 * as programs the test supplies, by name (`argv[0]`), so nothing it does reaches the machine.
 * A test drives what a command prints and when it ends through its program, and reads back what
 * was asked of the fake through `sandboxes`. `POSIX_PROGRAMS` holds stand-ins for the few
 * POSIX tools the contract runs.
 *
 * It is more forgiving than a real sandbox in one way to know: folders exist only as the paths
 * of the files in them, so a command's `cwd` is never checked, where a real provider fails a
 * command whose folder is not there.
 */

/** The folder a command runs in when it names none, as in E2B's sandboxes. */
export const FAKE_DEFAULT_CWD = '/home/user';

/**
 * A program a fake sandbox runs. What it returns is its exit code (`undefined` is 0). What it
 * throws rejects the command's result, which is how a test stands for a provider failing
 * mid-command: a `SandboxError` keeps its code, anything else becomes a `provider` error.
 */
export type FakeProgram = (child: FakeProcess) => number | void | Promise<number | void>;

/** What a fake program is handed. */
export interface FakeProcess {
  /** The whole command line, the program's own name first. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The sandbox's variables with the command's own on top. */
  readonly env: Readonly<Record<string, string>>;
  /** The sandbox's files, with relative paths taken from `cwd`. */
  readonly files: FakeFiles;
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Settles when the command is killed, or its sandbox stops or pauses. From then on its output
   * is dropped and what it returns is ignored, so a program that runs until stopped awaits it.
   */
  readonly killed: Promise<void>;
}

/** A fake sandbox's files. Relative paths are taken from a folder: the process's, or `FAKE_DEFAULT_CWD`. */
export interface FakeFiles {
  read(path: string): Uint8Array | undefined;
  /** The file decoded as UTF-8. */
  readText(path: string): string | undefined;
  /** Writes the file whole. Folders are implied by the paths of the files in them. */
  write(path: string, content: string | Uint8Array): void;
  /** Every file's absolute path, sorted. */
  paths(): string[];
}

export interface FakeTemplate {
  /** The files every sandbox from this template starts with, by absolute path. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}

export interface FakeProviderOptions {
  /** The templates sandboxes can start from. One empty template, `base`, when absent. */
  readonly templates?: Readonly<Record<string, FakeTemplate>>;
  /** The programs commands can run, by name. Any other program exits 127, as in a shell. */
  readonly programs?: Readonly<Record<string, FakeProgram>>;
  /** The capabilities the fake offers. None when absent, which is all an interface promises. */
  readonly capabilities?: readonly SandboxCapability[];
  /** Asked before each sandbox starts: a message makes `create` fail with it, as a `provider` error. */
  readonly failCreate?: (options: CreateSandboxOptions) => string | null | undefined;
}

/** One sandbox the fake made, as it is now. */
export interface FakeSandboxRecord {
  readonly id: string;
  readonly template: string;
  /** The variables it was created with. */
  readonly env: Readonly<Record<string, string>>;
  readonly state: 'running' | 'paused' | 'stopped';
  /** Every command started in it, oldest first. */
  readonly commands: readonly FakeCommandRecord[];
  /** Every port exposed in it, in the order first asked for. */
  readonly exposedPorts: readonly number[];
  /** Its files, to seed or inspect. Relative paths are taken from `FAKE_DEFAULT_CWD`. */
  readonly files: FakeFiles;
}

/** One command a fake sandbox ran, as it is now. */
export interface FakeCommandRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** `failed` when its program threw, or returned something that is no exit code. */
  readonly state: 'running' | 'exited' | 'killed' | 'failed';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class FakeProvider implements SandboxProvider {
  readonly pausing?: ProviderPausing;
  readonly snapshots?: ProviderSnapshots;

  private readonly records: FakeSandbox[] = [];
  private readonly templates = new Map<string, FileStore>();
  private readonly programs: ReadonlyMap<string, FakeProgram>;
  private readonly failCreate: FakeProviderOptions['failCreate'];
  private snapshotCount = 0;
  private readonly snapshotNames = new Set<string>();

  constructor(options: FakeProviderOptions = {}) {
    for (const [name, template] of Object.entries(options.templates ?? { base: {} })) {
      this.templates.set(name, FileStore.from(template.files ?? {}));
    }
    this.programs = new Map(Object.entries(options.programs ?? {}));
    this.failCreate = options.failCreate;

    const capabilities = new Set<string>(options.capabilities ?? []);
    for (const name of capabilities) {
      if (!(SANDBOX_CAPABILITIES as readonly string[]).includes(name)) {
        throw new SandboxError('invalid', `The fake knows no capability named ${name}.`);
      }
    }
    if (capabilities.has('pausing')) {
      this.pausing = {
        pause: async (sandboxId) => {
          const sandbox = this.existing(sandboxId);
          if (sandbox.state !== 'running') {
            throw new SandboxError('not-running', `Fake sandbox ${sandboxId} is ${sandbox.state}.`);
          }
          sandbox.state = 'paused';
          sandbox.endCommands();
        },
        resume: async (sandboxId) => {
          const sandbox = this.records.find((record) => record.id === sandboxId);
          if (!sandbox || sandbox.state === 'stopped') {
            throw new SandboxError('not-found', `There is no sandbox ${sandboxId} to resume.`);
          }
          sandbox.state = 'running';
          return this.handle(sandbox);
        },
      };
    }
    if (capabilities.has('snapshots')) {
      this.snapshots = {
        snapshot: async (sandboxId) => {
          const sandbox = this.existing(sandboxId);
          if (sandbox.state !== 'running') {
            throw new SandboxError('not-running', `Fake sandbox ${sandboxId} is ${sandbox.state}.`);
          }
          this.snapshotCount += 1;
          const name = `snapshot-${this.snapshotCount}`;
          this.templates.set(name, sandbox.store.copy());
          this.snapshotNames.add(name);
          return name;
        },
        remove: async (template) => {
          if (this.snapshotNames.delete(template)) {
            this.templates.delete(template);
          } else if (this.templates.has(template)) {
            throw new SandboxError('invalid', `${template} was not made by a snapshot.`);
          }
        },
      };
    }
  }

  /** Every sandbox this fake has made, oldest first, as each is now. */
  get sandboxes(): readonly FakeSandboxRecord[] {
    return this.records;
  }

  async create(options: CreateSandboxOptions): Promise<ProviderSandbox> {
    const failure = this.failCreate?.(options);
    if (failure) throw new SandboxError('provider', failure);
    const template = this.templates.get(options.template);
    if (!template) {
      throw new SandboxError('not-found', `There is no template named ${options.template}.`);
    }
    const sandbox = new FakeSandbox(
      `fake-${this.records.length + 1}`,
      options.template,
      { ...options.env },
      template.copy(),
    );
    this.records.push(sandbox);
    return this.handle(sandbox);
  }

  private existing(sandboxId: string): FakeSandbox {
    const sandbox = this.records.find((record) => record.id === sandboxId);
    if (!sandbox) throw new SandboxError('not-found', `There is no sandbox ${sandboxId}.`);
    return sandbox;
  }

  private handle(sandbox: FakeSandbox): ProviderSandbox {
    const ensureRunning = (): void => {
      if (sandbox.state !== 'running') {
        throw new SandboxError('not-running', `Fake sandbox ${sandbox.id} is ${sandbox.state}.`);
      }
    };
    return {
      id: sandbox.id,
      start: async (command) => {
        ensureRunning();
        return this.start(sandbox, command);
      },
      readFile: async (path) => {
        ensureRunning();
        const content = sandbox.files.read(path);
        if (!content) throw new SandboxError('not-found', `There is no file at ${path}.`);
        return content;
      },
      writeFile: async (path, content) => {
        ensureRunning();
        sandbox.files.write(path, content);
      },
      exposePort: async (port) => {
        ensureRunning();
        if (!sandbox.exposedPorts.includes(port)) sandbox.exposedPorts.push(port);
        return `https://${port}-${sandbox.id}.fake-sandbox.test`;
      },
      stop: async () => {
        if (sandbox.state === 'stopped') return;
        sandbox.state = 'stopped';
        sandbox.endCommands();
      },
    };
  }

  private start(sandbox: FakeSandbox, command: Command): ProviderCommand {
    const argv = [...command.argv];
    const cwd = resolvePath('/', command.cwd ?? FAKE_DEFAULT_CWD);
    const record = new FakeCommand(argv, cwd, { ...sandbox.env, ...command.env });
    sandbox.commands.push(record);

    const child: FakeProcess = {
      argv,
      cwd,
      env: record.env,
      files: sandbox.store.at(cwd),
      stdout: (text) => {
        if (record.state !== 'running') return;
        record.stdout += text;
        command.onStdout?.(text);
      },
      stderr: (text) => {
        if (record.state !== 'running') return;
        record.stderr += text;
        command.onStderr?.(text);
      },
      killed: record.killed,
    };

    const program = this.programs.get(argv[0] ?? '');
    const ran = Promise.resolve().then(async (): Promise<unknown> => {
      // A command killed before its program began never runs it, so leaves no files behind.
      if (record.state !== 'running') return null;
      if (!program) {
        child.stderr(`${argv[0]}: command not found\n`);
        return 127;
      }
      return (await program(child)) ?? 0;
    });

    const ended = new Promise<number | null>((resolve, reject) => {
      void record.killed.then(() => resolve(null));
      ran.then(
        (code) => {
          if (record.state !== 'running') return;
          if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 255) {
            record.fail();
            reject(
              new SandboxError(
                'provider',
                `The fake program ${argv[0]} returned ${String(code)}, which is no exit code.`,
              ),
            );
            return;
          }
          record.exit(code);
          resolve(code);
        },
        (error: unknown) => {
          if (record.state !== 'running') return;
          record.fail();
          reject(asSandboxError(error));
        },
      );
    });
    // A command nobody waits for must not leave its failure unhandled; whoever waits still sees it.
    ended.catch(() => undefined);

    return {
      wait: () => ended,
      kill: async () => record.kill(),
    };
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A sandbox's files, by absolute path. Every read and write copies, so no caller shares bytes with it. */
class FileStore {
  private constructor(private readonly files: Map<string, Uint8Array>) {}

  static from(files: Readonly<Record<string, string | Uint8Array>>): FileStore {
    const store = new FileStore(new Map());
    const root = store.at('/');
    for (const [path, content] of Object.entries(files)) root.write(path, content);
    return store;
  }

  copy(): FileStore {
    return new FileStore(new Map([...this.files].map(([path, bytes]) => [path, bytes.slice()])));
  }

  at(base: string): FakeFiles {
    const read = (path: string): Uint8Array | undefined =>
      this.files.get(resolvePath(base, path))?.slice();
    return {
      read,
      readText: (path) => {
        const bytes = read(path);
        return bytes && decoder.decode(bytes);
      },
      write: (path, content) => {
        const bytes = typeof content === 'string' ? encoder.encode(content) : content.slice();
        this.files.set(resolvePath(base, path), bytes);
      },
      paths: () => [...this.files.keys()].sort(),
    };
  }
}

class FakeSandbox implements FakeSandboxRecord {
  state: FakeSandboxRecord['state'] = 'running';
  readonly commands: FakeCommand[] = [];
  readonly exposedPorts: number[] = [];
  readonly files: FakeFiles;

  constructor(
    readonly id: string,
    readonly template: string,
    readonly env: Readonly<Record<string, string>>,
    readonly store: FileStore,
  ) {
    this.files = store.at(FAKE_DEFAULT_CWD);
  }

  /** Kills every command still running, as stopping or pausing a real sandbox does. */
  endCommands(): void {
    for (const command of this.commands) command.kill();
  }
}

class FakeCommand implements FakeCommandRecord {
  state: FakeCommandRecord['state'] = 'running';
  exitCode: number | null = null;
  stdout = '';
  stderr = '';
  readonly killed: Promise<void>;
  private readonly settleKilled: () => void;

  constructor(
    readonly argv: readonly string[],
    readonly cwd: string,
    readonly env: Readonly<Record<string, string>>,
  ) {
    let settle = (): void => undefined;
    this.killed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.settleKilled = settle;
  }

  exit(code: number): void {
    this.state = 'exited';
    this.exitCode = code;
  }

  fail(): void {
    this.state = 'failed';
  }

  kill(): void {
    if (this.state !== 'running') return;
    this.state = 'killed';
    this.settleKilled();
  }
}
