import { CONSOLA_NAMESPACE } from './support';
import type { EngineTool } from './ports';
import { LATER_KEYS, type AutomationMode } from '@consola/factory-spec';
import { assignedReviewsEntry } from './factoryTemplates';
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
    tools: Array<Pick<EngineTool, 'name' | 'description' | 'input'>>;
    actions: Array<{ name: string; appliesTo: Array<'pr' | 'issue'> }>;
    scopes: Array<{ name: string; path: string }>;
    taken: string[];
    /** The connection the workspace is bound to, if any. */
    boundConnection: string | null;
    /** The harness's name, and the entry `problem` it gives agent entries (null when it can run them). */
    harness: { name: string; problem: string | null };
}

/** The item fields a prompt may template: the ones every connection gives and nobody else wrote. */
export const TRUSTED_ITEM_FIELDS: readonly string[] = ['key', 'url', 'repo', 'number', 'type'];

/** The keys a later slice owns, grouped by what each arrives with, as the validator refuses them. */
const REFUSED_KEYS = Object.entries(
    Object.entries(LATER_KEYS).reduce<Record<string, string[]>>((groups, [key, arrivesWith]) => {
        (groups[arrivesWith] ??= []).push(`\`${key}\``);
        return groups;
    }, {})
)
    .map(([arrivesWith, keys]) => `${keys.join(', ')} arrive with ${arrivesWith}`)
    .join('; ');

/**
 * One example per kind of entry. Every one is parsed and resolved by a test,
 * and each appears in `GRAMMAR` as written, so the agent is never taught
 * something that fails. Names are unique: one name, one meaning.
 */
export const GRAMMAR_EXAMPLES: ReadonlyArray<{ title: string; entry: string }> = [
    {
        title: 'A tool, on a schedule',
        entry: `- name: clean-up-stale-sessions
  on: { cron: "0 9 * * 1-5" }
  run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
  mode: confirm`,
    },
    {
        title: 'An action, on an event',
        entry: `- name: review-requested-prs
  on: { github: pull_request.review_requested }
  filter: { authors_not: ["dependabot[bot]"] }
  run: { action: Review }
  mode: auto`,
    },
    {
        title: 'A prompt, on a schedule',
        entry: `- name: morning-inbox-digest
  on: { cron: "30 8 * * 1-5" }
  run:
    prompt: >-
      Use Consola’s list_inbox tool to read my Inbox, then write a short
      digest of what asks for my review.
  scope: api
  mode: auto`,
    },
    { title: 'Steps, on an event', entry: assignedReviewsEntry() },
];

/** What a `run:` step runs as, and what that means for a pull request's code. */
const RUN_AS =
    "your login environment and the workspace's bound account, in the item's own checkout or the scope folder, with git hooks off. " +
    "In a pull request's checkout, a command that builds or tests runs the author's code.";

const EXAMPLES = GRAMMAR_EXAMPLES.map((example) => `${example.title}:\n\n${example.entry}`).join('\n\n');

const GRAMMAR_PROSE = `Each automation is one item in the \`automations:\` list of factory.yml:

- name: <lowercase letters, digits and dashes; unique in the file>
  on: <a trigger: { cron: "<five fields>" } or { <connection>: <event> } or { <connection>: [<event>, …] }>
  run: <one target: { tool: consola#<tool>, with: { <arguments> } } or { action: <action name> } or { prompt: "<instructions>" }>
  steps: <instead of run: 1 to 20 steps, in file order; see Steps>
  filter: <event triggers only: the connection's filter fields>
  scope: <a prompt or steps on a schedule only: one of the workspace's scopes, by name>
  mode: auto | confirm | notify   # confirm when left out

Rules:
- An entry has run: or steps:, one or the other.
- A tool runs on a schedule. An event starts an agent session: an action or a prompt.
- An action is a verb on an item, so it runs on an event, never on a schedule, and must apply to the event's items.
- A prompt on a schedule names a scope. A pull request or issue runs in a worktree of its own repository, so an event takes no scope.
- An event trigger needs its connection bound to this workspace (Workspace settings).

Steps. Each step has exactly one of prompt:, action: or run:. A prompt: or action: step is a new read-only, unattended agent session on the default harness; a run: step is a shell command. Keys:
- id: ^[a-z][a-z0-9-]{0,31}$, unique, optional (an unnamed step is step-<n> and cannot be referenced).
- if: an expression; the step runs when it is true.
- prompt: instructions. action: one of the workspace's actions, which must apply to the item; its body is filled as an action's is, and {{ }} does not apply to it.
- run: a command. env: { NAME: "text {{ path }}" }, names ^[A-Z_][A-Z0-9_]*$, never CONSOLA_*. timeout: <n>s|m|h, default 10m, at most 1h.
- dry_run: report (default) or run: what a notify run does with the command; run is for a command that only reads.
- outputs: typed values the step must end with, at most 10, named ^[a-z][a-z0-9_]{0,31}$: { verdict: { enum: [a, b] }, n: integer, x: { type: number, minimum: 0, maximum: 1 }, ok: boolean, s: { type: string, maxLength: 500 } }. A string defaults to 1000 characters, at most 4000. A run: step may instead say outputs: { from: stdout, format: json | text }: stdout becomes its artifact \`output\`.
- artifacts: [names] an agent step must write before it ends; it may always write a handover. reads: [<step>.<artifact>] are the only earlier documents an agent step sees (<step>.handover, <step>.output).
Not supported yet, refused with a reason: ${REFUSED_KEYS}. A step has no inputs: use reads:.

A run: step reads outputs from the file named by $CONSOLA_OUTPUT, one key=value line each: echo "needed=true" >> "$CONSOLA_OUTPUT". It runs as ${RUN_AS}

Values: {{ }} works only in prompt: and env:, never in run:. Move {{item.url}} into env: and write "$PR" in the command; shape gh output with --jq. A path is item.<field>, steps.<id>.<output or artifact> (its content), or steps.<id>.<artifact>.file (an absolute path, for big documents). Prompts take trusted values only: item.${TRUSTED_ITEM_FIELDS.join(', ')} and enum, integer, number and boolean outputs; not item.title, item.author, string outputs or artifacts (text someone else wrote: use reads:). env: takes any path. A handover is required only when a later step reads it (reads: or env:).

if: expr := or; or := and ("||" and)*; and := unary ("&&" unary)*; unary := "!" unary | compare; compare := primary (("=="|"!="|"<"|"<="|">"|">=") primary)?; primary := path | 'text' | "text" | number | true | false | "(" expr ")"; path := steps.<id>.<output> | item.<field>. Write it as a YAML string of at most 500 characters (a bare if: true is refused). Types: == and != need matching types and an enum is a string whose literal must be one of its values; < <= > >= take numbers; && || ! take booleans; a boolean output alone works (if: steps.x.blocking). It reads outputs of earlier, named steps only, never an artifact (branch on an output). A step whose if: reads a step that did not complete is skipped.

${EXAMPLES}`;

const GRAMMAR = GRAMMAR_PROSE;

const MODES: AutomationCapabilities['modes'] = [
    {
        mode: 'auto',
        means:
            'Runs on its own when its trigger fires. A new or changed auto entry asks once before its first run, ' +
            'and so does any entry saved with consola_save_automation, whatever changed.',
    },
    { mode: 'confirm', means: 'The default. Shows what it would do and waits for the person to approve each run in Consola.' },
    {
        mode: 'notify',
        means:
            'Shows what it would do and tells the person. A one-step entry never starts or changes anything. ' +
            'A steps entry is a dry run: agent steps run, read-only, and run: steps are reported, not run (dry_run: run excepted), ' +
            'so it asks once first when it starts something.',
    },
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
    'comment, running tests) cannot be done by that session: say so to the person rather than saving an entry that ' +
    'runs and finds nothing. ' +
    "Posting or changing something is a run: step with the vendor's CLI (gh), after the read-only agent step.";

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
