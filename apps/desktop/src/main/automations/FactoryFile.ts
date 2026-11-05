import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendAutomationEntry, parseFactorySpec, type FactorySpecParseResult } from '@consola/factory-spec';

/** Workspace ids are generated tokens; anything else never reaches the filesystem as a path. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One workspace's personal automations: `~/.consola/workspaces/<id>/factory.yml`.
 * Under `~/.consola` with the worktrees rather than in Consola's own state, so
 * it is a text file a person can keep with their dotfiles. Keyed by id, not
 * name, so renaming a workspace never orphans its file. `CONSOLA_FACTORY_DIR`
 * replaces the `workspaces` folder — the seam tests use.
 */
export function workspaceFactoryPath(workspaceId: string): string {
    if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`Not a workspace id: ${JSON.stringify(workspaceId)}.`);
    const root = process.env.CONSOLA_FACTORY_DIR ?? path.join(os.homedir(), '.consola', 'workspaces');
    return path.join(root, workspaceId, 'factory.yml');
}

export interface LoadedFactoryFile {
    exists: boolean;
    spec: FactorySpecParseResult;
}

/** The automation that reviews pull requests asking for the person's review or assigned to them. */
export const ASSIGNED_REVIEWS_NAME = 'review-assigned-prs';

/** An action name as YAML: bare when it reads the same bare, quoted otherwise. */
function yamlName(action: string): string {
    return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(action) ? action : JSON.stringify(action);
}

/** `review-assigned-prs` running `action`, as one list item: the entry "Add" appends. */
export function assignedReviewsEntry(action: string): string {
    return [
        `- name: ${ASSIGNED_REVIEWS_NAME}`,
        '  on: { github: [pull_request.review_requested, pull_request.assigned] }',
        '  filter: { authors_not: ["dependabot[bot]"] }',
        `  run: { action: ${yamlName(action)} }`,
        '  mode: auto',
    ].join('\n');
}

const indent = (text: string, prefix: string) =>
    text
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');

const HEADER = `# This workspace's automations, run by Consola while it is open.
# Each one acts only on this workspace.
# Modes: auto | confirm (the default: you approve each run) | notify (report only).
# Sessions an automation starts are read-only: they read and report, and never
# run the code they look at or act on GitHub as you.
# To turn an example on, uncomment its lines.
version: 1
automations:
`;

/** What review-assigned-prs does, said where a person reading the file meets it. */
function describeAssignedReviews(what: string): string {
    return [
        'When a pull request asks for your review or is assigned to you, run',
        `${what} on it, read-only, in its own worktree, so the findings are`,
        'waiting when you sit down. Only requests from now on count, and each pull',
        'request is reviewed once. "auto" asks you once, before the first review.',
    ].join('\n');
}

const CLEANUP_EXAMPLE = `  # - name: clean-up-stale-sessions
  #   # Every morning, remove sessions whose pull request was merged or closed,
  #   # with their Consola worktrees and branches. Anything with unsaved or
  #   # unpushed work is kept. Starts as "confirm": you approve each run.
  #   on: { cron: "0 9 * * *" }
  #   run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
  #   mode: confirm
`;

/**
 * Written by "Open file" (and "Add") when there is no file yet. With a pull
 * request action, automatic reviews are on: the entry is live, in `auto`,
 * which still asks once before the first review. Without one there is
 * nothing to run, so the entry is commented out with a line saying what to
 * add first.
 *
 * A commented example's description is commented one level deeper than the
 * example, inside the entry. Turning it on means selecting it and toggling
 * the comment, which strips one level from every line: prose at the same
 * level as the YAML would become YAML, and the file would stop loading.
 */
export function factoryTemplate(prAction: string | null): string {
    const review = prAction
        ? `${indent(describeAssignedReviews(`your ${prAction} action`), '  # ')}\n${indent(assignedReviewsEntry(prAction), '  ')}\n`
        : `${indent(
              [
                  assignedReviewsEntry('Review').split('\n')[0],
                  '  # Add an action for pull requests in Settings › Actions, then uncomment this and name it under run.',
                  indent(describeAssignedReviews('that action'), '  # '),
                  ...assignedReviewsEntry('Review').split('\n').slice(1),
              ].join('\n'),
              '  # '
          )}\n`;
    return `${HEADER}${review}${CLEANUP_EXAMPLE}`;
}

/**
 * One workspace's spec file: read, parsed, watched.
 *
 * Watched by polling its stat rather than `fs.watch`: the file and even its
 * directory may not exist yet, and editors replace files atomically — both
 * cases that event-based watching misses silently, which is the one failure
 * a scheduler cannot afford.
 */
export class FactoryFile {
    private watching = false;

    constructor(
        public readonly filePath: string,
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

    /** Create the file from `template` if missing; returns its path. */
    public async ensureExists(template: string): Promise<string> {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            await fs.promises.writeFile(this.filePath, template, { flag: 'wx' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        return this.filePath;
    }

    /**
     * Add one automation at the end of the file's list, leaving every other
     * entry and comment as the person wrote it. Written whole, through a
     * temporary file, so the watcher never reads half of it.
     */
    public async appendAutomation(entryYaml: string): Promise<void> {
        // Through any symlink to the file itself — one kept with dotfiles stays a link.
        const target = await fs.promises.realpath(this.filePath);
        const text = await fs.promises.readFile(target, 'utf8');
        const next = appendAutomationEntry(text, entryYaml);
        const temporary = `${target}.${process.pid}.tmp`;
        await fs.promises.writeFile(temporary, next);
        await fs.promises.rename(temporary, target);
    }
}
