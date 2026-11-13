import type { AutomationMode } from '@consola/factory-spec';
import { CONSOLA_NAMESPACE, type ToolDefinition } from '../tools/Tool';
import { connectionCatalog, type ConnectionCatalogEntry } from './connections';

/**
 * What automations can do in one workspace, said for an agent about to write
 * an entry: the grammar, the triggers, targets and modes that exist, and what
 * this workspace has — so it drafts something that runs rather than learning
 * from refusals. The answer to `automation_capabilities`.
 */
export interface AutomationCapabilities {
    file: { path: string; exists: boolean };
    /** The entry grammar, its rules, and one example per kind of run. */
    grammar: string;
    modes: Array<{ mode: AutomationMode; means: string }>;
    triggers: {
        cron: string;
        /** Each connection's events and filter fields, and whether this workspace is bound to it. */
        connections: Array<ConnectionCatalogEntry & { bound: boolean }>;
    };
    targets: {
        /** The tools an automation may name, with what each argument means. */
        tools: Array<{ ref: string; description: string; arguments: Array<{ name: string; description: string }> }>;
        /** The workspace's actions, by name, and the items each applies to. */
        actions: Array<{ name: string; appliesTo: Array<'pr' | 'issue'> }>;
        prompt: string;
    };
    /** Where a scheduled prompt can run, by name. */
    scopes: Array<{ name: string; path: string }>;
    /** Names already in the file: a new entry needs another, or `replace: true` to change that one. */
    taken: string[];
    /** The workspace's default harness, which every agent run starts on. */
    harness: { name: string; canRunAgents: boolean; problem?: string };
    readOnlyLimits: string;
}

export interface CapabilitiesInput {
    filePath: string;
    fileExists: boolean;
    /** The registry's automatable tools. */
    tools: Array<Pick<ToolDefinition, 'name' | 'description' | 'input'>>;
    actions: Array<{ name: string; appliesTo: Array<'pr' | 'issue'> }>;
    scopes: Array<{ name: string; path: string }>;
    taken: string[];
    /** The connection the workspace is bound to, if any. */
    boundConnection: string | null;
    /** The harness's name, and the entry `problem` it gives agent entries (null when it can run them). */
    harness: { name: string; problem: string | null };
}

const GRAMMAR = `Each automation is one item in the \`automations:\` list of factory.yml:

- name: <lowercase letters, digits and dashes; unique in the file>
  on: <a trigger: { cron: "<five fields>" } or { <connection>: <event> } or { <connection>: [<event>, …] }>
  run: <one target: { tool: consola#<tool>, with: { <arguments> } } or { action: <action name> } or { prompt: "<instructions>" }>
  filter: <event triggers only: the connection's filter fields>
  scope: <a prompt on a schedule only: one of the workspace's scopes, by name>
  mode: auto | confirm | notify   # confirm when left out

Rules:
- A tool runs on a schedule. An event starts an agent session: an action or a prompt.
- An action is a verb on an item, so it runs on an event, never on a schedule, and must apply to the event's items.
- A prompt on a schedule names a scope. A pull request or issue runs in a worktree of its own repository, so an event takes no scope.
- An event trigger needs its connection bound to this workspace (Workspace settings).

A tool, on a schedule:

- name: clean-up-stale-sessions
  on: { cron: "0 9 * * 1-5" }
  run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
  mode: confirm

An action, on an event:

- name: review-assigned-prs
  on: { github: [pull_request.review_requested, pull_request.assigned] }
  filter: { authors_not: ["dependabot[bot]"] }
  run: { action: Review }
  mode: auto

A prompt, on a schedule:

- name: morning-inbox-digest
  on: { cron: "30 8 * * 1-5" }
  run:
    prompt: >-
      Use Consola’s list_inbox tool to read my Inbox, then write a short
      digest of what asks for my review.
  scope: api
  mode: auto`;

const MODES: AutomationCapabilities['modes'] = [
    {
        mode: 'auto',
        means:
            'Runs on its own when its trigger fires. A new or changed auto entry asks once before its first run, ' +
            'and so does any entry saved with consola_save_automation, whatever changed.',
    },
    { mode: 'confirm', means: 'The default. Shows what it would do and waits for the person to approve each run in Consola.' },
    { mode: 'notify', means: 'Shows what it would do and tells the person; never starts or changes anything.' },
];

const CRON =
    'Five fields — minute hour day-of-month month day-of-week — in local time, quoted: ' +
    '{ cron: "0 9 * * 1-5" } is weekdays at 9:00. No seconds field and no nicknames. ' +
    'Runs only while Consola is open; occurrences missed while it was closed run once when it next opens.';

const PROMPT =
    'run: { prompt: "…" } starts a read-only session with these instructions. On a schedule it runs in its scope’s ' +
    'folder; on an event, in a worktree of the item’s repository, with the item’s pull request or issue to read.';

const READ_ONLY_LIMITS =
    'An automation’s agent session (an action or a prompt) is read-only and unattended: it can read the files in ' +
    'its folder and use Consola’s work_item_context and list_inbox tools, and nothing else — no shell, no gh, and ' +
    'no network beyond those two tools. A job that needs more (summarising what merged last week, posting a ' +
    'comment, running tests) cannot be automated today: say so to the person rather than saving an entry that ' +
    'runs and finds nothing.';

/** Assemble the description; pure, so what the agent is told is what this workspace has. */
export function describeCapabilities(input: CapabilitiesInput): AutomationCapabilities {
    return {
        file: { path: input.filePath, exists: input.fileExists },
        grammar: GRAMMAR,
        modes: MODES,
        triggers: {
            cron: CRON,
            connections: connectionCatalog().map((connection) => ({
                ...connection,
                bound: connection.id === input.boundConnection,
            })),
        },
        targets: {
            tools: input.tools.map((tool) => ({
                ref: `${CONSOLA_NAMESPACE}#${tool.name}`,
                description: tool.description,
                arguments: Object.entries(tool.input).map(([name, schema]) => ({
                    name,
                    description: schema.description ?? '',
                })),
            })),
            actions: input.actions.map((action) => ({ name: action.name, appliesTo: [...action.appliesTo] })),
            prompt: PROMPT,
        },
        scopes: input.scopes.map((scope) => ({ name: scope.name, path: scope.path })),
        taken: [...input.taken],
        harness: {
            name: input.harness.name,
            canRunAgents: input.harness.problem === null,
            ...(input.harness.problem !== null ? { problem: input.harness.problem } : {}),
        },
        readOnlyLimits: READ_ONLY_LIMITS,
    };
}
