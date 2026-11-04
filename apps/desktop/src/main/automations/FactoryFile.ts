import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFactorySpec, type FactorySpecParseResult } from '@consola/factory-spec';

/** `~/.consola/factory.yml`, or `CONSOLA_FACTORY_FILE` — the seam tests use. */
export function personalFactoryPath(): string {
    return process.env.CONSOLA_FACTORY_FILE ?? path.join(os.homedir(), '.consola', 'factory.yml');
}

export interface LoadedFactoryFile {
    exists: boolean;
    spec: FactorySpecParseResult;
}

/** Shown by "Open file" when there is no file yet: valid, inert, and self-explaining. */
export const FACTORY_TEMPLATE = `# Consola automations, run by Consola while it is open.
# Modes: auto | confirm (the default: you approve each run) | notify (report only).
version: 1
automations:
  # Every morning, remove sessions whose pull request was merged or closed,
  # with their Consola worktrees and branches. Anything with unsaved or
  # unpushed work is kept. Starts as "confirm": you approve each run.
  # - name: clean-up-stale-sessions
  #   on: { cron: "0 9 * * *" }
  #   run: consola#cleanup_stale_sessions
  #   with: { pr_states: [merged, closed] }
  #   mode: confirm
`;

/**
 * The personal spec file: read, parsed, watched.
 *
 * Watched by polling its stat rather than `fs.watch`: the file and even its
 * directory may not exist yet, and editors replace files atomically — both
 * cases that event-based watching misses silently, which is the one failure
 * a scheduler cannot afford.
 */
export class FactoryFile {
    private watching = false;

    constructor(
        public readonly filePath: string = personalFactoryPath(),
        private readonly pollMs = 2000
    ) {}

    public async load(): Promise<LoadedFactoryFile> {
        let text: string;
        try {
            text = await fs.promises.readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return { exists: false, spec: { automations: [], issues: [] } };
            }
            return {
                exists: true,
                spec: {
                    automations: [],
                    issues: [{ message: `Could not read the file: ${(error as Error).message}`, path: '' }],
                },
            };
        }
        return { exists: true, spec: parseFactorySpec(text) };
    }

    public watch(onChange: () => void): void {
        if (this.watching) return;
        this.watching = true;
        fs.watchFile(this.filePath, { interval: this.pollMs, persistent: false }, (current, previous) => {
            if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) {
                onChange();
            }
        });
    }

    public unwatch(): void {
        if (!this.watching) return;
        this.watching = false;
        fs.unwatchFile(this.filePath);
    }

    /** Create the file from the template if missing; returns its path. */
    public async ensureExists(): Promise<string> {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            await fs.promises.writeFile(this.filePath, FACTORY_TEMPLATE, { flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        return this.filePath;
    }
}
