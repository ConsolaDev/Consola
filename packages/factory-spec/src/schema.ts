import { stringify } from 'yaml';
import { z } from 'zod';
import { cronError } from './cron';
import { AUTOMATION_NAME_PATTERN } from './names';
import { parseManualTrigger, parsePollTrigger, type ManualTrigger, type PollTrigger } from './poll';
import { parseToolRef, type RunTarget } from './runTarget';
import {
  ACTION_ON_KEYED_POLL,
  checkSteps,
  LATER_KEYS,
  laterKeyMessage,
  stepsSchema,
  type StepEntry,
  ENVIRONMENT_IN_AGENT_FILE,
} from './steps';
import { branchPlaceholderNames } from './branchName';
import {
  isItemCheckout,
  isRunOwnedCheckout,
  MAX_REPOS,
  ON_EXHAUSTED_OUTSIDE,
  parseBudget,
  parseEntryCheckout,
  parseRetry,
  REPO_ENTRY_SHAPE,
  REPO_PATTERN,
  type EntryCheckout,
  type Fail,
} from './flow';

/**
 * `auto` runs as soon as the trigger fires. `confirm` previews and waits for
 * a person to approve. `notify` previews and reports, changing nothing.
 * `confirm` is the default: anything a person did not click asks first.
 */
export const AUTOMATION_MODES = ['auto', 'confirm', 'notify'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export { AUTOMATION_NAME_PATTERN };

/** A connection's id in `on:` — `github`, later `jira`, `slack`, or a manifest's own. */
export const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** A connection's event: lowercase words, dotted — `pull_request.review_requested`, `mention`. */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export interface CronTrigger {
  kind: 'cron';
  cron: string;
}

/**
 * `on: { <connection>: <event> | [<event>, ...], ...params }`. The spec fixes
 * the grammar; which connections and events exist — and which parameters an
 * event takes — is the runner's business, exactly as tool namespaces are.
 */
export interface EventTrigger {
  kind: 'event';
  connection: string;
  /** One or more of the connection's events; an item in any of them fires. */
  events: string[];
  /** The event's own parameters: every key of `on` after the first. */
  params: Record<string, unknown>;
}

export type Trigger = CronTrigger | EventTrigger | PollTrigger | ManualTrigger;

interface AutomationCommon {
  name: string;
  trigger: Trigger;
  /** Which items fire an event trigger; fields are the connection's, validated by the runner. */
  filter?: Record<string, unknown>;
  /** One of the workspace's scopes, by name: where an agent runs when there is no item repo to run in. */
  scope?: string;
  /** `on: manual` only: which items a run on demand takes. */
  appliesTo?: Array<'pr' | 'issue'>;
  mode: AutomationMode;
  /**
   * `checkout: { pr: item }`: the run works in its item's read-only checkout,
   * as an item run does without it; `checkout: { repo, branch, from? }`: in a
   * checkout of its own, on a branch it cuts (slice 3-B). Steps entries only;
   * present only when written.
   */
  checkout?: EntryCheckout;
  /** `budget: { usd }`: what a run may spend, checked between steps. Steps entries only; present only when written. */
  budget?: { usd: number };
  /** `on_failure: { retry }`: how many times the whole run starts again by itself. Steps entries only; present only when written. */
  onFailure?: { retry: number };
  /** 1-based line of the entry in the file, for error and UI pointers. */
  line?: number;
  /**
   * The file it lives in, relative to the factory folder: `factory.yml` or
   * `automations/<name>.yaml`. Set by the folder's parsers; never hashed,
   * since where an automation lives is not what it does.
   */
  file?: string;
}

/**
 * An entry has `run:` (one thing, today's shape) or `steps:` (a pipeline),
 * never both. A legacy entry carries no `steps` key at all, so it parses and
 * hashes exactly as it did before steps existed.
 */
export type Automation = AutomationCommon &
  ({ run: RunTarget; steps?: never } | { steps: StepEntry[]; run?: never });

export type StepsAutomation = Extract<Automation, { steps: StepEntry[] }>;

export function isStepsEntry(automation: Automation): automation is StepsAutomation {
  return automation.steps !== undefined;
}

const TRIGGER_EXAMPLE =
  'e.g. `on: { cron: "0 9 * * *" }`, `on: { poll: { every: 30m, run: …, key: .id } }`, `on: manual` or `on: { github: pull_request.review_requested }`';

const NOT_A_CONNECTION = (id: string) =>
  `"${id}" is not a trigger. The first key of \`on\` is \`cron\`, \`poll\`, \`manual\` or a lowercase connection id, ${TRIGGER_EXAMPLE}.`;

/** Triggers a later slice brings, refused with what they arrive with. */
const LATER_TRIGGERS: Record<string, string> = {
  webhook: '`webhook` arrives with the headless runner; it is not supported yet.',
  consola: '`consola` arrives with connections as data; it is not supported yet.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exactly one trigger: the first key names it — `cron`, or a connection whose
 * value is the event — and any further keys are that event's parameters
 * (Jira's `to:`, Slack's `channel:`). Key order is what tells the two apart:
 * a parameter can look exactly like a connection id.
 */
const triggerSchema = z.unknown().transform((on, ctx): Trigger => {
  const fail = (message: string, path: string[] = []): never => {
    ctx.addIssue({ code: 'custom', message, path });
    return z.NEVER;
  };
  if (on === 'manual') return { kind: 'manual' };
  if (!isRecord(on)) return fail(`Expected a trigger, ${TRIGGER_EXAMPLE}.`);
  const [kind, ...rest] = Object.keys(on);
  if (!kind) return fail(`Expected a trigger, ${TRIGGER_EXAMPLE}.`);

  if (kind === 'cron') {
    if (rest.length > 0) {
      return fail(
        `A cron trigger takes no parameters; remove ${rest.map((key) => `\`${key}\``).join(', ')}.`,
        [rest[0]],
      );
    }
    if (typeof on.cron !== 'string')
      return fail('Expected a quoted cron expression, e.g. "0 9 * * *".', ['cron']);
    const problem = cronError(on.cron);
    if (problem) return fail(problem, ['cron']);
    return { kind: 'cron', cron: on.cron.trim() };
  }

  if (kind === 'poll' || kind === 'manual') {
    let reported = false;
    const report = (message: string, path: string[] = []) => {
      reported = true;
      ctx.addIssue({ code: 'custom', message, path });
    };
    const parsed =
      kind === 'poll'
        ? parsePollTrigger(on.poll, rest, report, NOT_A_CONNECTION, CONNECTION_ID_PATTERN)
        : parseManualTrigger(on.manual, rest, report);
    return parsed && !reported ? parsed : z.NEVER;
  }
  // Own keys only: `in` would take `constructor` or `toString` for a later trigger.
  if (Object.prototype.hasOwnProperty.call(LATER_TRIGGERS, kind))
    return fail(LATER_TRIGGERS[kind], [kind]);

  if (!CONNECTION_ID_PATTERN.test(kind)) return fail(NOT_A_CONNECTION(kind), [kind]);
  const written = on[kind];
  const listed = Array.isArray(written) ? written : [written];
  if (listed.length === 0) return fail(`List at least one event after \`${kind}:\`.`, [kind]);
  const events: string[] = [];
  for (const event of listed) {
    if (typeof event !== 'string' || !EVENT_NAME_PATTERN.test(event.trim())) {
      return fail(
        `Expected an event name after \`${kind}:\`, lowercase and dotted, e.g. pull_request.review_requested.`,
        [kind],
      );
    }
    const name = event.trim();
    if (events.includes(name)) return fail(`\`${name}\` is listed twice.`, [kind]);
    events.push(name);
  }
  const params: Record<string, unknown> = {};
  for (const key of rest) params[key] = on[key];
  return { kind: 'event', connection: kind, events, params };
});

const RUN_KEYS = ['action', 'prompt', 'tool'] as const;

/** The pre-object form: `run: <ref>`, with a tool's arguments beside it as a top-level `with:`. */
class StringRun {
  constructor(
    readonly written: string,
    readonly args: unknown,
  ) {}

  /** The one line that replaces both keys. */
  replacement(): string {
    const written = this.written.trim();
    if (!parseToolRef(written)) return `run: { action: ${written || 'Review'} }`;
    const args =
      this.args === undefined
        ? ''
        : `, with: ${stringify(this.args, { collectionStyle: 'flow' }).trim()}`;
    return `run: { tool: ${written}${args} }`;
  }
}

/**
 * Folds the old pair into one value before the entry is parsed, so it is
 * reported once, with the whole line to write, rather than as two issues
 * that each give half of it.
 */
function foldStringRun(entry: unknown): unknown {
  if (!isRecord(entry) || typeof entry.run !== 'string') return entry;
  const { with: args, ...rest } = entry;
  return { ...rest, run: new StringRun(entry.run, args) };
}

/** `applies_to: [pr, issue]`: one or both, each once, in the order written. */
const appliesToSchema = z.unknown().transform((written, ctx): Array<'pr' | 'issue'> => {
  const fail = (message: string): never => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  const expected = 'Expected `pr`, `issue` or both.';
  if (!Array.isArray(written) || written.length === 0) return fail(expected);
  const kinds: Array<'pr' | 'issue'> = [];
  for (const kind of written) {
    if (kind !== 'pr' && kind !== 'issue') return fail(expected);
    if (kinds.includes(kind)) return fail(`\`${kind}\` is listed twice.`);
    kinds.push(kind);
  }
  return kinds;
});

/** `run:` as an object with exactly one of action, prompt or tool. */
const runSchema = z.unknown().transform((run, ctx): RunTarget => {
  const fail = (message: string, path: string[] = []): never => {
    ctx.addIssue({ code: 'custom', message, path });
    return z.NEVER;
  };
  if (run instanceof StringRun) {
    return fail(
      `\`run:\` is an object now: write \`${run.replacement()}\`, or \`run: { prompt: "…" }\` for a prompt of its own.`,
    );
  }
  if (!isRecord(run))
    return fail('Expected `run:` to be an object with one of `action`, `prompt` or `tool`.');

  const unknown = Object.keys(run).filter(
    (key) => !(RUN_KEYS as readonly string[]).includes(key) && key !== 'with',
  );
  if (unknown.length > 0) {
    return fail(
      `Unrecognized key in \`run\`: ${unknown.join(', ')}. Expected one of action, prompt or tool.`,
      [unknown[0]],
    );
  }
  const present = RUN_KEYS.filter((key) => key in run);
  if (present.length !== 1) {
    return fail(
      present.length === 0
        ? 'Expected one of `action`, `prompt` or `tool` in `run`.'
        : `\`run\` names one thing to run; got ${present.join(' and ')}.`,
    );
  }
  const [kind] = present;
  if ('with' in run && kind !== 'tool') return fail('Only a tool takes `with:`.', ['with']);

  if (kind === 'tool') {
    const ref = typeof run.tool === 'string' ? parseToolRef(run.tool) : null;
    if (!ref)
      return fail(`${JSON.stringify(run.tool)} is not a tool reference (namespace#tool).`, [
        'tool',
      ]);
    const args = run.with ?? {};
    if (!isRecord(args)) return fail('Expected `with:` to be a mapping of arguments.', ['with']);
    return { kind: 'tool', ...ref, with: args };
  }
  const value = run[kind];
  if (typeof value !== 'string' || !value.trim()) {
    return fail(
      kind === 'action'
        ? 'Expected an action name, e.g. `action: Review`.'
        : 'Expected the prompt to send.',
      [kind],
    );
  }
  return kind === 'action'
    ? { kind: 'action', ref: value.trim(), name: value.trim() }
    : { kind: 'prompt', ref: 'prompt', prompt: value };
});

/** Skills and servers are an agent's, named in its file; on an entry they say where they go. */
const ENTRY_SKILLS_AND_SERVERS =
  'Name skills and servers in an agent file (`agents/<name>.md`), then set `agent:` on a step.';

/** Named rather than left to `strict()`, whose "unrecognized key" would not say why. */
function explained(message: string) {
  return z.never({ error: message }).optional();
}

/**
 * An entry key read by one of `flow.ts`' parsers, which names its own key
 * first in each issue's path: here the path is already at the key.
 */
function flowKey<T>(parse: (value: unknown, fail: Fail) => T | undefined) {
  return z
    .unknown()
    .transform((value, ctx): T => {
      const parsed = parse(value, (message, path = []) =>
        ctx.addIssue({ code: 'custom', message, path: path.slice(1) }),
      );
      return parsed === undefined ? z.NEVER : parsed;
    })
    .optional();
}

/** `checkout: { pr: item }`'s words where an entry's items are never pull requests. */
export const PR_ITEM_NEEDS_PRS = '`pr: item` needs items that are pull requests.';

/** A run-owned checkout's branch that names an item, on an entry with none. */
const BRANCH_NEEDS_AN_ITEM =
  'This automation has no item; its branch takes `{{run.id}}`, e.g. `consola/run-{{run.id}}`.';
/** A run-owned checkout's branch that names `{{item.number}}`, on a keyed poll. */
const BRANCH_NEEDS_A_NUMBER = "A poll's items have no number; use `{{item.key}}`.";
const CHECKOUT_SAYS_WHERE = 'The checkout says where this runs; remove `scope:`.';

/** Every key a later slice owns, refused with what it arrives with; `with` keeps its own message above. */
function laterEntryKeys() {
  return Object.fromEntries(
    Object.keys(LATER_KEYS)
      .filter((key) => key !== 'with')
      .map((key) => [key, explained(laterKeyMessage(key))]),
  );
}

/**
 * Exactly one of `run:` and `steps:`. Checked before the object is parsed: an
 * issue in the trigger, or a refused key, aborts the object and would hide it.
 */
function requireOneOf(entry: unknown, ctx: z.RefinementCtx): unknown {
  if (!isRecord(entry)) return entry;
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined;
  if (has('run') && has('steps')) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'An entry has `run:` or `steps:`, not both.',
    });
  } else if (!has('run') && !has('steps')) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'Expected `run:` or `steps:`: say what this automation does.',
    });
  }
  return entry;
}

export function automationSchema() {
  const entrySchema = automationEntrySchema();
  // Not `z.preprocess`: zod 4 stops a pipe at the first issue, which would
  // hide the entry's own issues behind the one-of issue. The entry is parsed
  // whatever that check found, and both are reported, one-of first.
  return z.unknown().transform((raw, ctx): Automation => {
    const entry = requireOneOf(foldStringRun(raw), ctx);
    const parsed = entrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
      return z.NEVER;
    }
    return parsed.data;
  });
}

function automationEntrySchema() {
  return z
    .object({
      name: z
        .string()
        .regex(
          AUTOMATION_NAME_PATTERN,
          'Use lowercase letters, digits and dashes, e.g. clean-up-stale-sessions.',
        ),
      on: triggerSchema,
      run: runSchema.optional(),
      steps: stepsSchema().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      scope: z.string().trim().min(1, 'Name one of the workspace’s scopes.').optional(),
      applies_to: appliesToSchema.optional(),
      mode: z.enum(AUTOMATION_MODES).default('confirm'),
      checkout: flowKey(parseEntryCheckout),
      budget: flowKey(parseBudget),
      on_failure: flowKey(parseRetry),
      with: explained(
        'Move `with:` under `run:` — only a tool takes arguments: `run: { tool: …, with: { … } }`.',
      ),
      max_turns: explained('`max_turns` goes on a step, not on the automation.'),
      agent: explained('`agent:` goes on a step, not on the automation.'),
      skills: explained(ENTRY_SKILLS_AND_SERVERS),
      mcpServers: explained(ENTRY_SKILLS_AND_SERVERS),
      // Control flow belongs to the steps, so an entry says where it goes.
      gate: explained('A gate is a step; put it in `steps:`.'),
      repeat: explained('A loop is a step; put it in `steps:`.'),
      on_exhausted: explained(ON_EXHAUSTED_OUTSIDE),
      // biome-ignore lint/suspicious/noThenProperty: `then:` is a factory.yml key; this schema is never awaited.
      then: explained('`then:` goes on a step.'),
      environment: explained(ENVIRONMENT_IN_AGENT_FILE),
      ...laterEntryKeys(),
      // A file belongs to one workspace, so there is nothing to select.
      workspace: explained(
        'Not needed: this file belongs to one workspace, and its automations act only on it.',
      ),
    })
    .strict()
    .superRefine((entry, ctx) => {
      const issue = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      const { on: trigger, run, steps } = entry;
      // A field that failed is already reported, and its value is not one.
      if (!trigger?.kind) return;
      if (entry.applies_to && trigger.kind !== 'manual') {
        issue(
          'applies_to',
          '`applies_to` is for `on: manual`: it says which items a run on demand takes.',
        );
      }
      // `run:` or `steps:` is checked before parsing (`requireOneOf`), so it is reported with every other issue.
      if (run && steps) return;
      if (!run && !steps) return;

      // An automation with no item: a schedule, or a run on demand that names no kind of item.
      const noItem = trigger.kind === 'cron' || (trigger.kind === 'manual' && !entry.applies_to);
      const poll = trigger.kind === 'poll';
      // Wording is today's for a schedule; the last sentence says why for the others.
      const why =
        trigger.kind === 'cron'
          ? 'A schedule has no item to run on.'
          : 'This automation has no item to run on.';
      const needsScope = () => {
        if (!entry.scope)
          issue('scope', `Say where this runs: \`scope: <one of the workspace’s scopes>\`. ${why}`);
      };
      if (trigger.kind === 'cron' && entry.filter) {
        issue('filter', '`filter` narrows which items fire an event; a schedule has no items.');
      }
      if (poll && entry.filter) issue('filter', 'Filter in the command, for example with `--jq`.');
      if (trigger.kind === 'manual' && entry.filter) {
        issue(
          'filter',
          '`filter` narrows which items fire an event; a run on demand has no event.',
        );
      }
      if (trigger.kind === 'manual' && entry.applies_to && entry.scope && run?.kind !== 'tool') {
        issue(
          'scope',
          'A run on a pull request or issue works in a checkout of its own repository, so it takes no scope.',
        );
      }
      const keyed = poll && trigger.key !== undefined;

      // What a run of `steps:` has, one per run: on a single `run:` they say where they go.
      if (run) {
        for (const key of ['checkout', 'budget', 'on_failure'] as const)
          if (entry[key] !== undefined) issue(key, `\`${key}\` goes with \`steps:\`.`);
      }
      if (steps && isItemCheckout(entry.checkout)) {
        // Items that are never pull requests: none, a keyed poll's, or a run on demand's that names no `pr`.
        const neverPrs =
          noItem ||
          keyed ||
          (trigger.kind === 'manual' && !(entry.applies_to ?? []).includes('pr'));
        if (neverPrs) issue('checkout', PR_ITEM_NEEDS_PRS);
        else if (entry.scope) issue('scope', CHECKOUT_SAYS_WHERE);
      }
      // A checkout the run owns says where it works, and its branch names only what the items have.
      if (steps && isRunOwnedCheckout(entry.checkout)) {
        if (entry.scope) issue('scope', CHECKOUT_SAYS_WHERE);
        const names = branchPlaceholderNames(entry.checkout.branch);
        const atBranch = (message: string) =>
          ctx.addIssue({ code: 'custom', path: ['checkout', 'branch'], message });
        if (noItem && names.some((name) => name === 'item.key' || name === 'item.number'))
          atBranch(BRANCH_NEEDS_AN_ITEM);
        else if (keyed && names.includes('item.number')) atBranch(BRANCH_NEEDS_A_NUMBER);
      }

      if (steps) {
        if ((noItem || keyed) && !entry.checkout) needsScope();
        // A step that failed its own checks leaves no list to resolve against.
        if (Array.isArray(steps)) {
          checkSteps(
            steps,
            {
              trigger,
              appliesTo: entry.applies_to,
              runOwned: isRunOwnedCheckout(entry.checkout),
            },
            ['steps'],
            (message, path) => ctx.addIssue({ code: 'custom', path, message }),
          );
        }
        return;
      }
      if (!run?.kind) return;
      if (run.kind === 'action') {
        if (trigger.kind === 'cron') {
          issue(
            'run',
            'An action is a verb on an item, and a schedule has no item: write the job as `run: { prompt: "…" }`.',
          );
        } else if (noItem) {
          issue(
            'run',
            'An action is a verb on an item, and this automation has none: write the job as `run: { prompt: "…" }`.',
          );
        } else if (keyed) {
          issue('run', ACTION_ON_KEYED_POLL);
        }
      }
      if (run.kind === 'prompt' && (noItem || keyed)) needsScope();
      if (run.kind === 'tool' && entry.scope) {
        issue(
          'scope',
          'A tool acts on the whole workspace; `scope` is only for runs that start an agent.',
        );
      }
    })
    .transform((entry): Automation => {
      const common = {
        name: entry.name,
        trigger: entry.on,
        ...(entry.filter ? { filter: entry.filter } : {}),
        ...(entry.scope ? { scope: entry.scope } : {}),
        ...(entry.applies_to ? { appliesTo: entry.applies_to } : {}),
        mode: entry.mode,
      };
      // Only when written, so an entry without them parses, and hashes, as before (contract 14).
      return entry.steps
        ? {
            ...common,
            ...(entry.checkout ? { checkout: entry.checkout } : {}),
            ...(entry.budget ? { budget: entry.budget } : {}),
            ...(entry.on_failure ? { onFailure: entry.on_failure } : {}),
            steps: entry.steps,
          }
        : { ...common, run: entry.run! };
    });
}

/**
 * `repos:`, a list of at most 50 repositories as `owner/name`, each once
 * (case aside, as GitHub reads them). A problem here is the file's, so it
 * loads nothing, as any problem with the envelope.
 */
function reposSchema() {
  return z
    .unknown()
    .transform((value, ctx): string[] => {
      const at = (message: string, path: Array<string | number> = []) =>
        ctx.addIssue({ code: 'custom', message, path });
      if (!Array.isArray(value)) {
        at('`repos:` lists repositories as `owner/name`, e.g. `repos: [sprocket/catalog-portal]`.');
        return z.NEVER;
      }
      if (value.length > MAX_REPOS) {
        at(`\`repos:\` lists at most ${MAX_REPOS} repositories.`);
        return z.NEVER;
      }
      const seen = new Set<string>();
      let ok = true;
      value.forEach((entry, index) => {
        if (typeof entry !== 'string' || !REPO_PATTERN.test(entry)) {
          at(REPO_ENTRY_SHAPE, [index]);
          ok = false;
        } else if (seen.has(entry.toLowerCase())) {
          at(`\`${entry}\` is listed twice in \`repos:\`.`, [index]);
          ok = false;
        } else seen.add(entry.toLowerCase());
      });
      return ok ? (value as string[]) : z.NEVER;
    })
    .optional();
}

/**
 * The envelope. Strict on purpose: a typo'd top-level key would otherwise
 * be silently ignored, and an automation that never loads looks exactly like
 * one that has not fired yet.
 */
export const fileSchema = z
  .object({
    version: z.literal(1, { error: 'Expected `version: 1` at the top of the file.' }),
    // `automations:` with only comments under it is YAML null, and it is
    // what a file looks like once its last automation is commented out.
    automations: z
      .array(z.unknown())
      .nullish()
      .transform((automations) => automations ?? []),
    // Top-level keys a later slice owns, refused with what each arrives with.
    mcpServers: explained(
      'Inline server definitions arrive with connections as data. Name a server the harness already has in an agent file.',
    ),
    // The repositories this factory may write, each `owner/name` (slice 3-B).
    repos: reposSchema(),
    policy: explained('`policy` arrives with shared factories; it is not supported yet.'),
    library: explained('`library` arrives with shared factories; it is not supported yet.'),
    defaults: explained('`defaults` arrives with shared factories; it is not supported yet.'),
    name: explained('`name` arrives with shared factories; it is not supported yet.'),
    connections: explained(
      '`connections` arrives with connections as data; it is not supported yet.',
    ),
  })
  .strict();
