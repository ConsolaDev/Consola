import { CONSOLA_NAMESPACE } from './support';
import type { EngineTool } from './ports';
import {
  AUTOMATION_NAME_PATTERN,
  ENV_PREFIX_EXCEPTIONS,
  LATER_KEYS,
  MAX_AGENT_SERVERS,
  MAX_AGENT_SKILLS,
  MAX_SKILL_FILES,
  REFUSED_ENV_NAMES,
  REFUSED_ENV_PREFIXES,
  type AutomationMode,
} from '@consola/factory-spec';
import { assignedReviewsEntry, reReviewEntry } from './factoryTemplates';
import { OUTPUT_FILE_CAP_BYTES } from './steps/commandIO';
import { connectionCatalog, type ConnectionCatalogEntry } from './connections';

/**
 * What automations can do in one workspace, said for an agent about to write
 * an entry: the grammar, the triggers, targets and modes that exist, and what
 * this workspace has — so it drafts something that runs rather than learning
 * from refusals. The answer to `automation_capabilities`.
 */
/** One of the workspace's agents, as an agent writing an entry is told it: what `agent:` may name. */
export interface AgentCapability {
  name: string;
  description?: string;
  /** Its harness's id; absent, the workspace's default harness. */
  harness?: string;
  model?: string;
  maxTurns?: number;
  /** The servers it names, by name. */
  mcpServers: string[];
  skills: string[];
}

export interface AutomationCapabilities {
  file: { path: string; exists: boolean };
  /** The factory folder `file` is in: where automation files, agent files and skills live. */
  folder: { path: string };
  /** The entry grammar, its rules, and one example per kind of run. */
  grammar: string;
  modes: Array<{ mode: AutomationMode; means: string }>;
  triggers: {
    cron: string;
    /** `on: { poll: … }`: a command checked on a timer, and what it must print. */
    poll: string;
    /** `on: manual`: a run only when a person (or an agent) starts it. */
    manual: string;
    /** Each connection's events and filter fields, and whether this workspace is bound to it. */
    connections: Array<ConnectionCatalogEntry & { bound: boolean }>;
  };
  targets: {
    /** The tools an automation may name, with what each argument means. */
    tools: Array<{
      ref: string;
      description: string;
      arguments: Array<{ name: string; description: string }>;
    }>;
    /** The workspace's actions, by name, and the items each applies to. */
    actions: Array<{ name: string; appliesTo: Array<'pr' | 'issue'> }>;
    prompt: string;
  };
  /** Where a scheduled prompt can run, by name. */
  scopes: Array<{ name: string; path: string }>;
  /** Names already in the file: a new entry needs another, or `replace: true` to change that one. */
  taken: string[];
  /**
   * The workspace's default harness, which every agent run starts on.
   * `stepsProblem`: why its steps entries with an agent step would not run
   * there although it can run agents.
   */
  harness: { name: string; canRunAgents: boolean; problem?: string; stepsProblem?: string };
  /** The folder's agents, as last read: what a step's `agent:` may name. */
  agents: AgentCapability[];
  /**
   * The harnesses an agent file's `harness:` may name: enabled and not
   * archived, by id, each with the MCP servers its CLI last said it has
   * (absent until Consola has asked it).
   */
  harnesses: Array<{ id: string; name: string; servers?: string[] }>;
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
  /**
   * The harness's name, the entry `problem` it gives agent entries (null when
   * it can run them), and the one it gives steps entries with an agent step
   * when only those cannot run (`stepProblem`; null or absent when they can).
   */
  harness: { name: string; problem: string | null; stepProblem?: string | null };
  /** The folder's valid agents; absent, none. */
  agents?: AgentCapability[];
  /** The harnesses an agent may name, enabled and not archived, with their servers' names when known; absent, none. */
  harnesses?: Array<{ id: string; name: string; servers?: string[] }>;
  /** The factory folder; absent, `filePath`'s folder. */
  folderPath?: string;
}

/** The item fields a prompt may template: the ones every connection gives and nobody else wrote. */
export const TRUSTED_ITEM_FIELDS: readonly string[] = ['key', 'url', 'repo', 'number', 'type'];

/** The keys a later slice owns, grouped by what each arrives with, as the validator refuses them. */
const REFUSED_KEYS = Object.entries(
  Object.entries(LATER_KEYS).reduce<Record<string, string[]>>((groups, [key, arrivesWith]) => {
    const group = groups[arrivesWith] ?? [];
    group.push(`\`${key}\``);
    groups[arrivesWith] = group;
    return groups;
  }, {}),
)
  .map(([arrivesWith, keys]) => `${keys.join(', ')} arrive with ${arrivesWith}`)
  .join('; ');

/**
 * One example per kind of entry. Every one is parsed and resolved by a test,
 * and each appears in `GRAMMAR` as written, so the agent is never taught
 * something that fails. Names are unique: one name, one meaning. An example
 * whose steps run as agents carries their files (and its environment's)
 * beside it, each as written.
 */
export const GRAMMAR_EXAMPLES: ReadonlyArray<{
  title: string;
  entry: string;
  files?: Readonly<Record<string, string>>;
}> = [
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
  { title: 'Steps, on a poll', entry: reReviewEntry() },
  {
    title: 'Steps with a turn cap, on a schedule',
    entry: `- name: overnight-api-notes
  on: { cron: "0 7 * * 1-5" }
  scope: api
  mode: auto
  steps:
    - id: look
      prompt: Read what changed in api overnight, and write it up as your handover.
      max_turns: 20
    - id: tell
      prompt: Turn the overnight handover into a short note for the team.
      reads: [look.handover]`,
  },
  {
    title: 'A review loop with a gate, on an event',
    entry: `- name: review-loop-gated
  on: { github: pull_request.review_requested }
  checkout: { pr: item }
  budget: { usd: 2 }
  mode: auto
  steps:
    - id: polish
      repeat: { max: 2, until: steps.review.findings == 0 }
      steps:
        - id: review
          prompt: >-
            Review this pull request with Consola's work_item_context tool. Write each finding that must
            be fixed, with its file and line, as your handover, and set findings to how many there are.
          outputs: { findings: integer }
    - id: decide
      gate: { ask: Post the review? }
    - id: publish
      if: steps.decide.decision == 'approve'
      run: |
        gh api "repos/$REPO/pulls/$NUMBER/reviews" \\
          -f commit_id="$CONSOLA_CHECKOUT_HEAD" -f event=COMMENT -F body=@"$BODY_FILE"
      env:
        REPO: "{{item.repo}}"
        NUMBER: "{{item.number}}"
        BODY_FILE: "{{steps.review.handover.file}}"`,
  },
  {
    // North-star §4.1 as slice 3 runs it (Call 18: an example, not a gallery template). The one
    // change from the spec's text: under Call 9 a sandboxed agent cannot commit, so `ui-bugfixer`
    // leaves its changes for Consola to commit instead of committing them itself.
    title: 'A Jira bug to a pull request, in a sandbox',
    entry: `- name: ui-bug-to-pr
  on:
    poll:
      every: 10m
      run: |
        acli jira workitem search --json \\
            --jql 'project = SHOP AND type = Bug AND component = UI AND status = "To Do"' |
          jq '[.[] | { key, title: .fields.summary }]'
      key: .key
  checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.key}}" }
  mode: auto
  budget: { usd: 5 }
  steps:
    - id: triage
      agent: triager
      outputs:
        kind: { enum: [bug, feature, unclear] }
    - id: not-ours
      if: steps.triage.kind != 'bug'
      run: acli jira workitem comment create --key "$KEY" --body "$BODY"
      env: { KEY: "{{item.key}}", BODY: "{{steps.triage.handover}}" }
      then: stop
    - id: fix
      agent: ui-bugfixer
      prompt: Fix the bug described below. The triage handover is attached.
      reads: [triage.handover]
    - id: polish
      repeat: { max: 3, until: steps.review.findings == 0 }
      steps:
        - id: review
          agent: pre-pr-reviewer
          reads: [checkout.changes, fix.handover]
          outputs: { findings: integer }
        - id: address
          if: steps.review.findings > 0
          agent: ui-bugfixer
          prompt: Address the findings in the review handover.
          reads: [review.handover]
      on_exhausted:
        gate:
          ask: The review still has findings after 3 rounds. Open the pull request anyway?
          show: [review.handover, checkout.changes]
    - id: pr
      run: |
        git push origin "HEAD:refs/heads/$CONSOLA_BRANCH"
        echo "url=$(gh pr create --head "$CONSOLA_BRANCH" --title "$TITLE" --body-file "$BODY_FILE")" >> "$CONSOLA_OUTPUT"
      env: { TITLE: "{{item.key}}: {{item.title}}", BODY_FILE: "{{steps.fix.handover.file}}" }
      outputs: { url: string }
    - id: ticket
      run: |
        acli jira workitem transition --key "$KEY" --status "In Review"
        acli jira workitem comment create --key "$KEY" --body "PR: $PR_URL"
      env: { KEY: "{{item.key}}", PR_URL: "{{steps.pr.url}}" }`,
    files: {
      'agents/triager.md': `---
description: Triages UI bug reports for catalog-portal.
harness: claude-work
model: haiku
---
Decide whether the ticket below is a bug in catalog-portal's UI that a code change can fix. Set kind, and say why in
your handover, in a few lines a person can read on the ticket.
`,
      'agents/ui-bugfixer.md': `---
description: Fixes UI bugs in catalog-portal.
harness: claude-work
model: sonnet
tools: write
environment: sandboxed
max_turns: 60
---
You fix UI bugs in catalog-portal. Follow the repository's CLAUDE.md, which is attached. Reproduce the bug with a
test, fix it, and run the tests with \`pnpm test\`. Install with \`pnpm install --frozen-lockfile\`.
Leave your changes in the checkout; Consola commits them after the step, and never commit or push yourself.
Your handover is the pull request's description: what was wrong, what you changed, how it was tested.
`,
      'agents/pre-pr-reviewer.md': `---
description: Reviews a fix before it becomes a pull request.
harness: claude-work
model: sonnet
---
Review the changes on this branch: they are attached as \`checkout.changes\`, with the fix's handover; read the
files around them where it helps. Count the findings that must be fixed before a pull request, and write each with
its file and line in your handover.
`,
      'environments/sandboxed.yaml': `isolation: sandbox
network: [registry.npmjs.org]
env: [CI]
`,
    },
  },
];

/**
 * One example of agent files and automation files, each file as written. A
 * test parses every one with its folder (`parseFactory`) and resolves it,
 * and each file appears in the grammar under its path.
 */
export const AGENT_EXAMPLES: ReadonlyArray<{
  title: string;
  files: Readonly<Record<string, string>>;
}> = [
  {
    title: 'An agent on a schedule',
    files: {
      'agents/notes-writer.md': `---
description: Writes the overnight notes for api.
model: haiku
max_turns: 10
---
You write the overnight notes for the api team: what changed, what broke, and what needs a person.
Keep them short and plain; name each pull request by its number.
`,
      'automations/overnight-notes.yaml': `on: { cron: "0 7 * * 1-5" }
scope: api
mode: auto
steps:
  - id: look
    agent: notes-writer
  - id: tell
    agent: notes-writer
    prompt: Turn the overnight handover into the note the team reads first.
    reads: [look.handover]
`,
    },
  },
  {
    title: 'An investigator with a connector and a skill',
    files: {
      'agents/investigator.md': `---
description: Looks into a new alert and says where to start.
harness: claude-work
model: haiku
max_turns: 30
mcpServers:
  - claude.ai Coralogix
  - grafana: [query_logs]
skills: [incident-triage]
---
You look into alerts for the api team: what fired, what it shares with earlier alerts, and where to look first.
Follow the incident-triage checklist, read logs with the tools you were given, and change nothing.
`,
      'skills/incident-triage/SKILL.md': `---
name: incident-triage
description: The api team's checklist for a new alert.
---
1. Read the alert and the service it names.
2. Look for the same alert in the last week.
3. Say what changed just before it fired.
`,
      'automations/investigate-alerts.yaml': `on:
  poll: { every: 30m, run: ./list-alerts, key: .id }
scope: api
mode: confirm
steps:
  - id: investigate
    agent: investigator
    prompt: Look into the alert described below, and say where to start.
`,
    },
  },
];

/** What a `run:` step runs as, and what that means for a pull request's code. */
const RUN_AS =
  "your login environment and the workspace's bound account, in the item's own checkout or the scope folder, with git hooks off. " +
  "In a pull request's checkout, a command that builds or tests runs the author's code.";

/** What 3-B adds: the repositories a factory writes to, a run's own checkout, write agents and their environments. */
const WRITING = [
  'Writing:',
  '- `repos:` in factory.yml lists the repositories a factory may write to, as `owner/name`.',
  '- `checkout: { repo, branch, from? }` on an automation gives each run a checkout of its own: a clone of `repo` whose git folder sits outside the checkout, on `branch` (a template starting with a literal folder, `fix/{{item.key}}`; also `{{item.number}}`, `{{run.id}}`) cut from the default branch or `from`. Consola commits what each agent step leaves (a `sandbox` agent cannot commit; on `host`, leaving the commit to Consola is a convention, and an agent\'s own commit is kept when the branch still descends from where its step started), checks the branch between steps, and never pushes: a `run:` step does (`git push origin "HEAD:refs/heads/$CONSOLA_BRANCH"`).',
  "- An agent file's `tools:` is `read-only`, `edit` (files) or `write` (files and a shell); `edit` and `write` need `environment: <name>` and a checkout the run owns, and run on Claude only.",
  // Canary row 49 (the conductor's binding): the sandbox does not keep the keychain service from the shell.
  "- `environments/<name>.yaml`: `isolation: host` (your machine as it is: a convention) or `isolation: sandbox` (macOS: its shell writes only in the checkout and Claude's shared temporary folder, reaches `network:` hosts only, gets `env:` names only and no token Consola holds, and cannot read your credential folders; it can still ask macOS for your keychain items through `security`, and other files stay readable).",
  "- `artifacts: [{ name, path }]` on a write agent's step is a file it writes in the checkout; `reads: [checkout.changes]` and a gate's `show: [checkout.changes]` give the branch's diff.",
].join('\n');

/** What 3-A adds to steps: loops, gates, stopping early, retrying what cannot have acted, a budget, a named checkout. */
const CONTROL_FLOW = [
  'Control flow in steps:',
  '- `gate: { ask, show?, choices? }` is a step of its own: the run waits, with no process, until a person answers in Consola. Its output is `decision` (one of `choices`, or `approve`); Reject ends the run. No tool answers a gate.',
  '- `repeat: { max, until }` with `steps:` (1 to 10, no loop inside) runs them again until `until` holds, at most `max` (1 to 10) rounds; `on_exhausted:` is `fail` (the default), `continue`, `{ gate: "<question>" }` or `{ gate: { ask, show } }`.',
  '- `then: stop` on a step ends the run, completed, once that step completes.',
  '- `on_failure: { retry: <0-3> }` on a step retries it by itself only if it cannot have acted: an agent naming no MCP server, or a `dry_run: run` command. On the automation, the whole run starts again only if nothing in it acted.',
  "- `budget: { usd: <n> }` on the automation stops the run at its next step once its agents' turns cost that much (0.01 to 1000).",
  "- `checkout: { pr: item }` names the pull request's read-only checkout, where a run on a pull request works anyway.",
].join('\n');

const EXAMPLES = GRAMMAR_EXAMPLES.map(
  (example) =>
    `${example.title}:\n\n${example.entry}${
      example.files
        ? `\n\nWith these files beside it:\n\n${Object.entries(example.files)
            .map(([file, text]) => `${file}:\n\n${text}`)
            .join('\n')}`
        : ''
    }`,
).join('\n\n');

const AGENT_FILE_EXAMPLES = AGENT_EXAMPLES.map(
  (example) =>
    `${example.title}:\n\n${Object.entries(example.files)
      .map(([file, text]) => `${file}:\n\n${text}`)
      .join('\n')}`,
).join('\n\n');

/** The rule a person meets when an agent file or a skill changes: what it uses asks again. */
const AGENT_EDIT_ASKS_AGAIN =
  'An edit to an agent file or a skill makes every automation that uses it ask again before its next unattended run; a poll entry stops checking until the person allows it.';

/** The review's verdict (c) on Call 4: a body that opens with a rule needs frontmatter first. */
const FRONTMATTER_FIRST =
  'A file whose first line is --- begins with its frontmatter, so a body that should open with a Markdown rule (---) needs frontmatter first, even an empty one: a line ---, then a line ---.';

/** What naming a server grants, and where its name comes from. */
const SERVER_RULES =
  "On a step that works in someone else's checkout (a pull request or issue), only claude.ai connectors are offered. " +
  'Naming a server grants every tool it has, writing ones included; narrow it to named tools with - <server>: [<tool>, …]. ' +
  "harnesses lists each harness's servers by name, once Consola has asked its CLI.";

const FOLDER_PROSE = `The factory folder. A workspace's automations live in its factory folder (folder.path): factory.yml, automations/<name>.yaml (one automation per file), agents/<name>.md (an agent a step runs as), skills/<name>/SKILL.md (a skill an agent names) and environments/<name>.yaml (where a write agent runs: see Writing). A file's name is its name: ${AUTOMATION_NAME_PATTERN.source}, so agents/investigator.md is the agent investigator. Any other file in automations/, agents/, skills/ or environments/ is an issue (dotfiles, and what an editor or the OS leaves beside a file, such as x.md~, #x.md#, x.orig or Thumbs.db, are passed over), and so is a file (or one of those folders) that is a link leading outside the folder: Consola reads only files inside it. connections/ and evals/ are read from later slices: their files have no effect yet. The folder applies as a unit: while any file has a problem, the version that last applied keeps running, and an automation removed from the files stops at once.

Agent files. agents/<name>.md is optional YAML frontmatter between two --- lines, then the agent's standing instructions: its body, at least one line that is not blank, at most 64 KB, with no {{ }} (an agent is the same for every step that uses it: put item values in the step's prompt:). ${FRONTMATTER_FIRST} Keys, each optional:
- description: one line of at most 200 characters, for the person. It, a server's name and the model are visible text: letters, numbers, punctuation, symbols and plain spaces (no line or paragraph separators, combining marks, invisible fillers or format characters).
- harness: a harness's id from harnesses (letters, digits, _ and -); absent, the workspace's default harness. Its steps' sessions run there.
- model: a model the harness's CLI takes (opus, haiku, or a full model id), passed as --model; absent, the harness's own. A model the harness does not list is shown as a notice; a step on a model the CLI does not have fails.
- max_turns: 1 to 500, the default turn cap of every step that uses the agent; a step's own max_turns overrides it.
- tools: read-only (the default), edit or write; edit and write need environment: and a checkout the run owns.
- environment: an environment in environments/, by name: where an edit or write agent's session runs (see Writing). A read-only agent names none.
- mcpServers: names of servers the harness's CLI already has, each optionally narrowed to its tools (- notion, or - grafana: [query_logs]), at most ${MAX_AGENT_SERVERS}. skills: folder names in skills/, at most ${MAX_AGENT_SKILLS}. An agent that names either names its harness too.
${SERVER_RULES}
Refused, with a reason: name: (the file's name is the agent's), hooks, permissionMode, allowed-tools and allowedTools (Consola compiles an agent's permissions from tools, mcpServers and skills), secrets (a later slice), and any other key.
A step runs as an agent with agent: <name>, the agent's file name without .md. Alone, the agent's body is the step's instructions; beside prompt: or action:, the body comes first and the step's own instruction after it. The step's session runs on the agent's harness, with its model. An entry whose step names no agent file, or one with problems of its own, does not run. agent:, skills: and mcpServers: never go on an entry, and a step names skills and servers only through its agent.

Automation files. automations/<name>.yaml holds one automation, its keys at the top level as a factory.yml entry's are, with no name: (the file's name is the automation's) and no version: (it belongs to factory.yml). A name is unique across the folder: one defined both in factory.yml and as a file is refused in both. New entries saved with consola_save_automation go to factory.yml; one that replaces an entry living in its own file rewrites that file.

Skills. skills/<name>/SKILL.md starts with its frontmatter, holding name: (the folder's name) and description: (1 to 1,024 characters); license: and compatibility: (text) and metadata: (names to text) are allowed too. A skill holds regular files and folders only, no symlinks, at most ${MAX_SKILL_FILES} files and 2 MB. Refused: hooks (they would run even in a read-only session), allowed-tools (name servers and tools in the agent file), any other key, and a command at load (the characters ! and \` together) anywhere in SKILL.md, in a file with a text extension, or in any file that is valid UTF-8 (a binary, such as an image or a font, is not read for it).

${AGENT_EDIT_ASKS_AGAIN}

${AGENT_FILE_EXAMPLES}`;

const GRAMMAR_PROSE = `Each automation is one item in the \`automations:\` list of factory.yml, or a file of its own (see The factory folder):

- name: <lowercase letters, digits and dashes; unique in the folder>
  on: <a trigger: { cron: "<five fields>" } or { <connection>: <event> } or { <connection>: [<event>, …] } or { poll: { … } } or manual>
  run: <one target: { tool: consola#<tool>, with: { <arguments> } } or { action: <action name> } or { prompt: "<instructions>" }>
  steps: <instead of run: 1 to 20 steps, in file order; see Steps>
  filter: <event triggers only: the connection's filter fields>
  applies_to: <on: manual only: [pr], [issue] or [pr, issue]; which items a run on demand takes>
  scope: <a prompt or steps on a schedule only: one of the workspace's scopes, by name>
  mode: auto | confirm | notify   # confirm when left out

Rules:
- An entry has run: or steps:, one or the other.
- A tool runs on a schedule. An event starts an agent session: an action or a prompt.
- An action is a verb on an item, so it runs on an event, never on a schedule, and must apply to the event's items.
- A prompt on a schedule names a scope. A pull request or issue runs in a worktree of its own repository, so an event takes no scope.
- An event trigger needs its connection bound to this workspace (Workspace settings).

Poll. on: { poll: { every: 30m, run: |
<command>, item: { github: .url }, changed: .head } } runs a command on a timer, as the person, and fires for each item it prints. It is how to trigger on anything a CLI can answer, including what Consola's own events do not cover. Keys:
- every: <n>m or <n>h, from 1m to 24h.
- run: the check command. Its stdout must be a JSON array of objects, one per item, for example [{"url":"https://github.com/sprocket/catalog-portal/pull/51","title":"Fix the cart total","head":"a1b2c3"}]. Anything else fails the check. No {{ }}: values reach commands only as environment variables.
- item: { <connection>: <field path> }, the field that holds the URL of a work item of that connection, such as { github: .url }; the run is on that pull request or issue, in a checkout of its own, so it takes no scope. Or key: <field path>, an identity with no work item: such an entry runs a prompt or steps in a scope (scope:), and cannot use an action. Exactly one of item: and key:.
- changed: <field path>, optional: the item fires again when this value changes (a head commit, an updated_at).
- timeout: <n>s|m, optional: default 1m, at most 5m.
The command does the filtering: an entry has no filter: on a poll. Filter in the command, for example with --jq, and print only the items that should run. An item that leaves the result is forgotten, so it fires again when it comes back; while it stays, it fires again only when its changed: value moves. Every field other than the item's identity was written by other people: it is allowed in env: and if:, never in a prompt (use reads:). A poll does not check until the person allows it: saving the entry (consola_save_automation included) shows them the command and waits for their OK. Changing the command, the item or changed: path, the timeout or the steps asks again; changing only every: does not. A new one records what is there on its first check and fires nothing; items already in the result are run from Run on… instead. A pull request or issue whose repository is not cloned into one of the workspace's scopes is skipped.

on: manual runs only when a person, or an agent, starts it. Add applies_to: [pr] (or [issue], or both) to make it a run on an item they pick: the item is then item.<field> as an event's is, in a checkout of its own, with no scope. Without applies_to: it has no item and a prompt or steps entry takes a scope. It takes no filter: and no inputs:.

Previous. In an entry that runs on an item, previous.<step>.<artifact> is what the last run of this automation on the same item wrote: previous.review.handover is that run's review. It works in reads: and env: only, never in a prompt or if:: it is material, not a value to branch on. It is empty on the first run, so write the prompt to cope: it should say what to do when there is no earlier document.

Steps. Each step has one of prompt:, action:, agent: <name> or run:; an agent: may also stand beside a prompt: or an action: (see Agent files). A prompt:, action: or agent: step is a new read-only, unattended agent session, on its agent's harness or else the default one; a run: step is a shell command. Keys:
- id: ^[a-z][a-z0-9-]{0,31}$, unique, optional (an unnamed step is step-<n> and cannot be referenced; step-<n> and previous are refused as ids).
- if: an expression; the step runs when it is true.
- prompt: instructions. action: one of the workspace's actions, which must apply to the item; its body is filled as an action's is, and {{ }} does not apply to it.
- run: a command. env: { NAME: "text {{ path }}" }, names ^[A-Z_][A-Z0-9_]*$, never CONSOLA_*. timeout: <n>s|m|h, default 10m, at most 1h.
- env: these names and prefixes are refused because they make a program run a value: ${REFUSED_ENV_NAMES.join(', ')}, and every name matching ${REFUSED_ENV_PREFIXES.map((prefix) => `${prefix}*`).join(', ')} (${ENV_PREFIX_EXCEPTIONS.join(' and ')} are allowed). Values stay data; set such a variable inside run: if you must.
- dry_run: report (default) or run: what a notify run does with the command; run is for a command that only reads.
- outputs: typed values the step must end with, at most 10, named ^[a-z][a-z0-9_]{0,31}$, never handover or output (reserved, like artifact names): { verdict: { enum: [a, b] } (1 to 20 values, each 1 to 64 characters, no line breaks), n: integer, x: { type: number, minimum: 0, maximum: 1 }, ok: boolean, s: { type: string, maxLength: 500 } }. A string defaults to 1000 characters, at most 4000. A run: step may instead say outputs: { from: stdout, format: json | text }: stdout becomes its artifact \`output\`.
- artifacts: [names] an agent step must write before it ends; it may always write a handover. reads: [<step>.<artifact>] are the only earlier documents an agent step sees (<step>.handover, <step>.output).
- max_turns: 1 to 500, an agent step's turn cap: the step fails when its turn reaches it ("It hit its limit of <n> turns before finishing."), with no reminder. Without it a turn runs until it ends, at most an hour. Each agent step's cost and turns are recorded on its run.
Not supported yet, refused with a reason: ${REFUSED_KEYS}. A step has no inputs: use reads:.

A run: step reads outputs from the file named by $CONSOLA_OUTPUT, one key=value line each: echo "needed=true" >> "$CONSOLA_OUTPUT". Set every declared output or the step fails; at most ${OUTPUT_FILE_CAP_BYTES / 1024} KB; no key<<EOF form. It runs as ${RUN_AS}

Values: {{ }} works only in prompt: and env:, never in run:. Move {{item.url}} into env: and write "$PR" in the command; shape gh output with --jq. A path is item.<field>, steps.<id>.<output or artifact> (its content), or steps.<id>.<artifact>.file (an absolute path, for big documents). Prompts take trusted values only: item.${TRUSTED_ITEM_FIELDS.join(', ')} and enum, integer, number and boolean outputs; not item.title, item.author, string outputs or artifacts (text someone else wrote: use reads:). env: takes any path. A handover is required only when a later step reads it (reads: or env:).

if: expr := or; or := and ("||" and)*; and := unary ("&&" unary)*; unary := "!" unary | compare; compare := primary (("=="|"!="|"<"|"<="|">"|">=") primary)?; primary := path | 'text' | "text" | number | true | false | "(" expr ")"; path := steps.<id>.<output> | item.<field>. Write it as a YAML string of at most 500 characters (a bare if: true is refused). Types: == and != need matching types and an enum is a string whose literal must be one of its values; < <= > >= take numbers; && || ! take booleans; a boolean output alone works (if: steps.x.blocking). It reads outputs of earlier, named steps only, never an artifact (branch on an output). A step whose if: reads a step that did not complete is skipped.

${CONTROL_FLOW}

${WRITING}

${EXAMPLES}`;

const GRAMMAR = `${GRAMMAR_PROSE}\n\n${FOLDER_PROSE}`;

const MODES: AutomationCapabilities['modes'] = [
  {
    mode: 'auto',
    means:
      'Runs on its own when its trigger fires. A new or changed auto entry asks once before its first run, ' +
      'and so does any entry saved with consola_save_automation, whatever changed. ' +
      'A run asked for with consola_run_automation always waits for the person, and approving it runs that run only: ' +
      'it never lets the entry run on its own.',
  },
  {
    mode: 'confirm',
    means:
      'The default. Shows what it would do and waits for the person to approve each run in Consola.',
  },
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

const POLL =
  'on: { poll: { every: 30m, run: <command>, item: { github: .url }, changed: .head } } runs a command on a timer, ' +
  'as the person, and fires for each item it prints: a JSON array of objects. The command does the filtering. ' +
  'It does not check until the person allows it, and a new one records what is there and fires nothing. ' +
  'Runs only while Consola is open.';

const MANUAL =
  'on: manual runs only when a person or an agent starts it. With applies_to: [pr, issue] it runs on an item ' +
  'they pick (Run on…); without, it has no item.';

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
    folder: { path: input.folderPath ?? input.filePath.replace(/[\\/][^\\/]*$/, '') },
    grammar: GRAMMAR,
    modes: MODES,
    triggers: {
      cron: CRON,
      poll: POLL,
      manual: MANUAL,
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
          description: (schema as { description?: string }).description ?? '',
        })),
      })),
      actions: input.actions.map((action) => ({
        name: action.name,
        appliesTo: [...action.appliesTo],
      })),
      prompt: PROMPT,
    },
    scopes: input.scopes.map((scope) => ({ name: scope.name, path: scope.path })),
    taken: [...input.taken],
    harness: {
      name: input.harness.name,
      canRunAgents: input.harness.problem === null,
      ...(input.harness.problem !== null ? { problem: input.harness.problem } : {}),
      ...(typeof input.harness.stepProblem === 'string'
        ? { stepsProblem: input.harness.stepProblem }
        : {}),
    },
    agents: (input.agents ?? []).map((agent) => ({
      ...agent,
      mcpServers: [...agent.mcpServers],
      skills: [...agent.skills],
    })),
    harnesses: (input.harnesses ?? []).map((harness) => ({
      id: harness.id,
      name: harness.name,
      ...(harness.servers !== undefined ? { servers: [...harness.servers] } : {}),
    })),
    readOnlyLimits: READ_ONLY_LIMITS,
  };
}
