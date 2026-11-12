import type { AuthoringBasis, AuthoringRequest } from '../../shared/automations';
import { generateSessionInstanceId, primaryScope, type Session, type Workspace } from '../../shared/workspace';
import type { LaunchSessionFields } from '../SessionLauncher';
import { AUTOMATION_TEMPLATES } from './templates';

/**
 * "New automation", "Change with agent" and "Customize…": an ordinary
 * interactive session, with full tools under the person's own CLI
 * permissions, whose agent drafts an entry with the person and saves it
 * through `save_automation`. Nothing here writes the file: the agent does,
 * through the runner's checks, once the person agreed to the draft.
 */

/** What the session starts from, resolved: who it is called, and its entry as written. */
interface ResolvedBasis {
    kind: 'automation' | 'template';
    /** The automation's name, or the template's title. */
    name: string;
    entry: string;
}

/** Words of the description a session name keeps, and the characters they may take. */
const NAME_WORDS = 5;
const NAME_CHARS = 40;

/** A fence `text` cannot close: one backtick longer than any run of them inside it. */
function fenceFor(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The session's first prompt: short, since the capabilities tool carries the
 * detail. The person's description, the file, where to learn what is
 * possible, the read-only limits, and to confirm before saving.
 */
export function authoringPrompt(input: {
    description: string;
    filePath: string;
    basis?: { kind: 'automation' | 'template'; name: string; entry: string };
}): string {
    const { description, filePath, basis } = input;
    const asked = description.trim();
    const paragraphs: string[] = [];
    if (!basis) {
        paragraphs.push(`The person wants a new automation in this Consola workspace. In their words:\n\n${asked}`);
    } else {
        const fence = fenceFor(basis.entry);
        const block = `${fence}yaml\n${basis.entry}\n${fence}`;
        paragraphs.push(
            basis.kind === 'automation'
                ? `The person wants to change the automation "${basis.name}" in this Consola workspace. It reads today:\n\n` +
                      `${block}\n\nKeep its name, and save with replace: true so it is changed in place.`
                : `The person wants a new automation in this Consola workspace, starting from Consola’s template ` +
                      `“${basis.name}”:\n\n${block}`
        );
        if (asked) paragraphs.push(`What they want from it, in their words:\n\n${asked}`);
    }
    paragraphs.push(
        `Automations live in ${filePath}.`,
        'Before drafting anything, call consola_automation_capabilities to learn what this workspace can use: ' +
            'its triggers, targets, modes and scopes, and the names already taken.',
        'An automation’s session is read-only: no shell, no gh, and no network beyond Consola’s list_inbox and ' +
            'work_item_context tools. If the job needs more than that, tell the person it cannot be automated today ' +
            'rather than writing one that runs and finds nothing.',
        'Confirm the draft with the person before saving it: show them the entry you wrote.',
        'Save it with consola_save_automation rather than editing the file: it checks the entry the way the runner ' +
            'will, and refuses one that would not run, with the reasons.'
    );
    return paragraphs.join('\n\n');
}

/**
 * "New automation: ‹first words›" — the first five words of the description,
 * cut at 40 characters, with "…" when anything was left out. Changing an
 * automation always names it; a template without a description names the
 * template.
 */
export function authoringSessionName(
    description: string,
    basis?: { kind: 'automation' | 'template'; name: string }
): string {
    if (basis?.kind === 'automation') return `Change automation: ${basis.name}`;
    const words = description.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return `New automation: ${basis?.name ?? ''}`.trimEnd();
    let head = words.slice(0, NAME_WORDS).join(' ');
    let cut = words.length > NAME_WORDS;
    if (head.length > NAME_CHARS) {
        head = head.slice(0, NAME_CHARS).trimEnd();
        cut = true;
    }
    return `New automation: ${head}${cut ? '…' : ''}`;
}

export interface AuthoringDeps {
    getWorkspace(id: string): Workspace | undefined;
    launchSession(workspaceId: string, fields: LaunchSessionFields): Promise<Session>;
    /** The workspace's factory.yml path, for the prompt. */
    filePath(workspaceId: string): string;
    /** The entry a basis names, as written; null when there is no such automation or template. */
    basisEntry(workspaceId: string, basis: AuthoringBasis): Promise<string | null>;
}

/**
 * Start the session, on the workspace's default harness, in the requested
 * scope (the workspace's first when that one is gone). Everything is checked
 * before the session exists, so a refusal leaves nothing behind.
 */
export async function startAuthoring(deps: AuthoringDeps, request: AuthoringRequest): Promise<Session> {
    const workspace = deps.getWorkspace(request.workspaceId);
    if (!workspace) throw new Error(`No workspace ${request.workspaceId}.`);
    const description = request.description.trim();
    if (!description && !request.basis) throw new Error('Say what the automation should do, and when.');
    const scope = workspace.scopes.find((candidate) => candidate.id === request.scopeId) ?? primaryScope(workspace);
    if (!scope) throw new Error('Add a scope to this workspace first.');

    const basis = request.basis ? await resolveBasis(deps, workspace.id, request.basis) : undefined;
    return deps.launchSession(workspace.id, {
        name: authoringSessionName(description, basis),
        // Claude's own summary would otherwise rename it.
        nameIsUserSet: true,
        workspaceId: workspace.id,
        instanceId: generateSessionInstanceId(workspace.id),
        harnessId: workspace.defaultHarnessId,
        kind: 'interactive',
        scopeId: scope.id,
        // No toolPolicy: the person's own session, with full tools, its first
        // prompt delivered once the composer is ready.
        initialPrompt: authoringPrompt({ description, filePath: deps.filePath(workspace.id), basis }),
    });
}

async function resolveBasis(deps: AuthoringDeps, workspaceId: string, basis: AuthoringBasis): Promise<ResolvedBasis> {
    if ('automation' in basis) {
        const entry = await deps.basisEntry(workspaceId, basis);
        if (entry === null) throw new Error(`There is no automation named "${basis.automation}" in factory.yml.`);
        return { kind: 'automation', name: basis.automation, entry };
    }
    const template = AUTOMATION_TEMPLATES.find((candidate) => candidate.id === basis.template);
    const entry = template ? await deps.basisEntry(workspaceId, basis) : null;
    if (!template || entry === null) throw new Error(`There is no template "${basis.template}".`);
    return { kind: 'template', name: template.title, entry };
}
