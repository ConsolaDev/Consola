import {
  automationVersion,
  parseFactorySpec,
  serverHash,
  stepsResolvedBody,
} from '@consola/factory-spec';
import type { McpServerDefinition } from '@consola/factory-spec';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import type { EngineToolContext, McpCallOutcome } from './ports';
import { maskFormsOf } from './secrets/values';
import { CHECK_STALE } from './servers/checkServer';
import { INTERRUPTED_CALL } from './steps/recover';
import type { StepsRunPreview } from './steps/definition';
import { defineTool } from './tools.test-helpers';
import type { TestTool } from './tools.test-helpers';
import { BIND_HINT, stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';
import type { FakeServer, StepsHarness, StepsHarnessOptions } from './steps/steps.test-helpers';

/*
 * 5a-2: `uses:` steps, as the engine resolves, runs, recovers and checks
 * them, against the steps harness's fake MCP client (`world.mcp`). Nothing
 * here starts a server: the fake records every connect, call and close.
 */

/** The spec's `slack`, with its command an absolute path (nothing runs it: the fake answers). */
const SLACK_COMMAND = '/opt/sprocket/bin/slack-mcp';
const SLACK = `  slack:
    description: Posts to Sprocket's Slack as the support bot.
    command: ${SLACK_COMMAND}
    args: [--stdio]
    env: { SLACK_TEAM_ID: T0SPROCKET }
    secrets: [SLACK_BOT_TOKEN]
`;
const SLACK_DEFINITION: McpServerDefinition = {
  name: 'slack',
  transport: 'stdio',
  description: "Posts to Sprocket's Slack as the support bot.",
  command: SLACK_COMMAND,
  args: ['--stdio'],
  env: { SLACK_TEAM_ID: 'T0SPROCKET' },
  secrets: ['SLACK_BOT_TOKEN'],
};
/** The spec's `tracker`: Streamable HTTP, a header made from a secret. */
const TRACKER = `  tracker:
    url: https://mcp.tracker.sprocket.example/mcp
    headers: { Authorization: "Bearer \${TRACKER_TOKEN}" }
    secrets: [TRACKER_TOKEN]
`;

/** A factory.yml with these servers and entries (each a `  - name: …` item). */
const factory = (servers: string, ...entries: string[]) =>
  `version: 1\n${servers ? `mcpServers:\n${servers}` : ''}automations:\n${entries.join('')}`;

/** A scheduled steps entry in api: an agent step `triage`, then `steps` (each a `      - …` item). */
function entry(name: string, steps: string, extra = '    mode: auto\n'): string {
  return `  - name: ${name}\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n${extra}    steps:\n      - id: triage\n        prompt: Triage what came in.\n        outputs: { verdict: { enum: [post, skip] }, note: string }\n${steps}`;
}
const POST = `      - id: post
        uses: slack#chat_post_message
        with: { channel: C0SUPPORT1, text: "{{steps.triage.note}}" }
        outputs: { ts: string }
`;
/** A `uses:` step `id` calling `ref` with `with` (flow YAML). */
const call = (id: string, ref: string, withYaml: string, extra = '') =>
  `      - id: ${id}\n        uses: ${ref}\n        with: ${withYaml}\n${extra}`;
const BRIEF = entry('brief', POST);
const YAML = factory(SLACK + TRACKER, BRIEF);

const BOT_BINDING = { ref: 'keychain:consola/ws-1/personal/SLACK_BOT_TOKEN' };
const TRACKER_BINDING = {
  ref: 'op://Ops/Tracker/credential',
  kind: '1password' as const,
  label: '1Password (op://Ops/Tracker/credential)',
};
const BOT_VALUE = String.raw`stub-slack-secret-9c1e"\back%slash`;
const TRACKER_VALUE = 'stub-tracker-secret-4d7a%slash"q';
const BOUND = {
  bindings: { SLACK_BOT_TOKEN: BOT_BINDING, TRACKER_TOKEN: TRACKER_BINDING },
  values: { SLACK_BOT_TOKEN: BOT_VALUE, TRACKER_TOKEN: TRACKER_VALUE },
};

/*
 * Consola's tools as a test registry offers them: `cleanup_stale_sessions`
 * (destructive, its arguments choose what it acts on), `start_chat` (its
 * `prompt` is sent to a session), `list_things` (changes nothing),
 * `bare_tool` (automatable, no roles) and `hidden_tool` (not automatable).
 */
const CLEAN_UP = defineTool({
  name: 'cleanup_stale_sessions',
  description: 'Clean up sessions whose pull requests are done.',
  input: {
    pr_states: z.array(z.enum(['merged', 'closed'])).optional(),
    session_ids: z.array(z.string()).optional(),
  },
  roles: { pr_states: 'selector', session_ids: 'selector' },
  mutating: true,
  destructive: true,
  automatable: true,
  preview: async () => ({ summary: 'Would clean up 2 sessions.', data: { sessions: 2 } }),
  run: async () => ({ summary: 'Cleaned up 2 sessions.', data: { removed: 2 } }),
});
const START_CHAT = defineTool({
  name: 'start_chat',
  description: 'Start a chat with a prompt.',
  input: { prompt: z.string(), channel: z.string().optional() },
  roles: { prompt: 'prompt', channel: 'data' },
  mutating: false,
  automatable: true,
  run: async () => ({ summary: 'Started.', data: null }),
});
const LIST_THINGS = defineTool({
  name: 'list_things',
  description: 'List things.',
  input: { kind: z.string().optional() },
  roles: { kind: 'data' },
  mutating: false,
  automatable: true,
  run: async () => ({ summary: 'Listed.', data: [] }),
});
const BARE_TOOL = defineTool({
  name: 'bare_tool',
  description: 'A tool whose host gave its argument no role.',
  input: { target: z.string() },
  mutating: false,
  automatable: true,
  run: async () => ({ summary: 'Done.', data: null }),
});
const HIDDEN_TOOL = defineTool({
  name: 'hidden_tool',
  description: 'Not for automations.',
  input: {},
  mutating: false,
  automatable: false,
  run: async () => ({ summary: 'Done.', data: null }),
});
/** A tool with roles for some arguments only, one of them named as `Object.prototype` names a member. */
const ODD_TOOL = defineTool({
  name: 'odd_tool',
  description: 'A tool whose roles leave one argument out.',
  input: { note: z.string().optional(), constructor: z.string().optional() },
  roles: { note: 'data' },
  mutating: false,
  automatable: true,
  run: async () => ({ summary: 'Done.', data: null }),
});
const TOOLS = [CLEAN_UP, START_CHAT, LIST_THINGS, BARE_TOOL, HIDDEN_TOOL, ODD_TOOL];

const harness = (options: StepsHarnessOptions = {}) =>
  stepsHarness({ yaml: YAML, tools: TOOLS, secrets: BOUND, ...options });

const row = (h: StepsHarness, name = 'brief') =>
  h.service.list(WORKSPACE_ID).find((view) => view.name === name)!;
const problemOf = async (options: StepsHarnessOptions, name = 'brief') =>
  row(await harness(options), name).problem;

describe('an entry whose steps call a server (5a-2 Task 6)', () => {
  it('resolves against its server, keeps it in the definition, and starts nothing', async () => {
    const h = await harness();
    expect(row(h).problem).toBeUndefined();
    const run = (await h.service.trigger(WORKSPACE_ID, 'brief'))!;
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.servers).toEqual({ slack: SLACK_DEFINITION });
    expect(definition.calls?.post.arguments).toEqual([
      { name: 'channel', template: 'C0SUPPORT1', trust: 'literal', sources: [] },
      {
        name: 'text',
        template: '{{steps.triage.note}}',
        trust: 'untrusted',
        sources: [{ kind: 'output', step: 'triage', name: 'note', trusted: false }],
      },
    ]);
    expect(definition.calls?.post).toMatchObject({
      ref: 'slack#chat_post_message',
      server: 'slack',
      tool: 'chat_post_message',
      facts: { name: 'slack', transport: 'stdio', target: `${SLACK_COMMAND} --stdio` },
    });
    expect((h.store.get(run.id)!.result as StepsRunPreview).steps).toContainEqual({
      id: 'post',
      kind: 'uses',
    });
    // Resolving and firing start no server: only a call does, once a person allowed its version.
    expect(h.world.mcp.launches).toEqual([]);
  });

  it("can't run on a runner with no MCP client, while a call of Consola's own tool still can", async () => {
    expect(await problemOf({ mcp: 'none' })).toBe(
      "this runner can't call MCP servers, so `uses: slack#…` can't run here",
    );
    const own = factory(
      SLACK,
      entry('brief', call('post', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')),
    );
    expect(await problemOf({ mcp: 'none', yaml: own })).toBeUndefined();
  });

  it('runs only where the runner offers its server’s transport (review S11)', async () => {
    const TRACK = entry('track', call('file', 'tracker#create_issue', '{ title: Shipped }'));
    const tracked = factory(SLACK + TRACKER, BRIEF, TRACK);
    const httpOnly = await harness({ yaml: tracked, mcp: { transports: ['http'] } });
    expect(row(httpOnly).problem).toBe(
      "this runner can't start stdio servers, so `uses: slack#…` can't run here",
    );
    expect(row(httpOnly, 'track').problem).toBeUndefined();
    expect(await problemOf({ yaml: tracked, mcp: { transports: ['stdio'] } }, 'track')).toBe(
      "this runner can't call Streamable HTTP servers, so `uses: tracker#…` can't run here",
    );
  });
});

describe("a call of Consola's own tools in steps (5a-2 Task 6)", () => {
  const own = (step: string) => factory(SLACK, entry('tidy', step));
  const tidy = async (step: string) => problemOf({ yaml: own(step) }, 'tidy');

  it('resolves with its arguments as written, a destructive tool marked so', async () => {
    const h = await harness({
      yaml: own(call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')),
    });
    expect(row(h, 'tidy').problem).toBeUndefined();
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.calls?.clean).toEqual({
      ref: 'consola#cleanup_stale_sessions',
      server: 'consola',
      tool: 'cleanup_stale_sessions',
      arguments: [{ name: 'pr_states', template: ['merged'], trust: 'literal', sources: [] }],
      destructive: true,
    });
    // Consola's own tools are no factory server: nothing is kept for them.
    expect(definition).not.toHaveProperty('servers');
  });

  it('takes only trusted values in an argument that chooses what it acts on', async () => {
    expect(
      await tidy(
        call(
          'clean',
          'consola#cleanup_stale_sessions',
          '{ session_ids: ["{{steps.triage.note}}"] }',
        ),
      ),
    ).toBe(
      '`session_ids` chooses what `consola#cleanup_stale_sessions` acts on; it takes only trusted values',
    );
  });

  it('takes only trusted values in an argument sent to a session as typed', async () => {
    expect(
      await tidy(call('chat', 'consola#start_chat', '{ prompt: "{{steps.triage.note}}" }')),
    ).toBe('`prompt` is sent to a session as if you typed it; it takes only trusted values');
    // An enum output is trusted: it cannot carry instructions.
    expect(
      await tidy(call('chat', 'consola#start_chat', '{ prompt: "{{steps.triage.verdict}}" }')),
    ).toBeUndefined();
    // A data argument takes anything.
    expect(
      await tidy(
        call('chat', 'consola#start_chat', '{ prompt: Go, channel: "{{steps.triage.note}}" }'),
      ),
    ).toBeUndefined();
  });

  it('reads an argument its tool gives no role as one that chooses (Call 5)', async () => {
    expect(
      await tidy(call('aim', 'consola#bare_tool', '{ target: "{{steps.triage.note}}" }')),
    ).toBe('`target` chooses what `consola#bare_tool` acts on; it takes only trusted values');
    expect(await tidy(call('aim', 'consola#bare_tool', '{ target: catalog-portal }'))).toBe(
      undefined,
    );
    // A role is the tool's own: a name `Object.prototype` has is no role.
    expect(
      await tidy(call('odd', 'consola#odd_tool', '{ constructor: "{{steps.triage.note}}" }')),
    ).toBe('`constructor` chooses what `consola#odd_tool` acts on; it takes only trusted values');
  });

  it('refuses an argument the tool does not have, a tool no automation may run, and no tool', async () => {
    expect(await tidy(call('clean', 'consola#cleanup_stale_sessions', '{ nope: 1 }'))).toBe(
      'with: `nope` is not an argument of `consola#cleanup_stale_sessions` (it has: pr_states, session_ids)',
    );
    expect(await tidy(call('hide', 'consola#hidden_tool', '{}'))).toBe(
      'consola#hidden_tool cannot be run by an automation',
    );
    expect(await tidy(call('gone', 'consola#vanished', '{}'))).toBe(
      'there is no Consola tool named "vanished"',
    );
  });

  it('refuses dry_run: run on a tool that changes things (review Minor 13)', async () => {
    expect(
      await tidy(
        call(
          'clean',
          'consola#cleanup_stale_sessions',
          '{ pr_states: [merged] }',
          '        dry_run: run\n',
        ),
      ),
    ).toBe(
      "its step `clean` calls `consola#cleanup_stale_sessions`, which changes things, so it can't have `dry_run: run`",
    );
    expect(
      await tidy(call('look', 'consola#list_things', '{}', '        dry_run: run\n')),
    ).toBeUndefined();
  });

  it('resolves on items, where a one-step tool keeps its words (review M5)', async () => {
    const onItems = (body: string) =>
      factory('', `  - name: tidy\n    on: manual\n    applies_to: [pr]\n${body}`);
    const steps = `    steps:\n${call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')}`;
    expect(await problemOf({ yaml: onItems(steps) }, 'tidy')).toBeUndefined();
    expect(
      await problemOf(
        { yaml: onItems('    run: { tool: consola#cleanup_stale_sessions }\n') },
        'tidy',
      ),
    ).toMatch(/^applies_to gives each run an item, and a tool takes none/);
  });

  it("says a one-step tool of a server's namespace is a step", async () => {
    const yaml = factory(
      SLACK,
      '  - name: post\n    on: { cron: "0 9 * * 1-5" }\n    run: { tool: slack#chat_post_message }\n    mode: confirm\n',
    );
    expect(await problemOf({ yaml }, 'post')).toBe(
      "`slack#chat_post_message` is not one of Consola's tools. An MCP server's tool is a step: `steps: [{ uses: slack#chat_post_message, with: … }]`",
    );
  });
});

describe('the version of an entry that calls a server (5a-2 Task 6, Task 5’s engine half)', () => {
  const versionOf = (h: StepsHarness, name = 'brief') =>
    h.service.entryAgents(WORKSPACE_ID, name)!.version;
  const QUIET = `  - name: quiet\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: look\n        run: git log -1\n`;

  it("holds the server's definition, in exactly the entries that call it", async () => {
    const h = await harness({ yaml: factory(SLACK, BRIEF, QUIET) });
    const before = { brief: versionOf(h), quiet: versionOf(h, 'quiet') };
    // The engine's formula: the server's hash under `servers`, beside no action and no agent.
    const [automation] = parseFactorySpec(factory(SLACK, BRIEF)).automations;
    expect(before.brief).toBe(
      automationVersion(
        automation,
        stepsResolvedBody({}, {}, undefined, { servers: { slack: serverHash(SLACK_DEFINITION) } }),
      ),
    );
    await h.setYaml(factory(SLACK.replace('[--stdio]', '[--stdio, -v]'), BRIEF, QUIET));
    expect(versionOf(h)).not.toBe(before.brief);
    expect(versionOf(h, 'quiet')).toBe(before.quiet);
    await h.setYaml(
      factory(
        SLACK.replace('[SLACK_BOT_TOKEN]', '[SLACK_BOT_TOKEN, SLACK_TEAM_TOKEN]'),
        BRIEF,
        QUIET,
      ),
    );
    expect(versionOf(h)).not.toBe(before.brief);
    expect(versionOf(h, 'quiet')).toBe(before.quiet);
  });

  it('moves with no binding, and holds no server for Consola’s own tools', async () => {
    const h = await harness();
    const before = versionOf(h);
    h.world.secrets.bindings.set('SLACK_BOT_TOKEN', { ref: 'op://Ops/Slack/bot' });
    await h.service.reload(WORKSPACE_ID);
    expect(versionOf(h)).toBe(before);
    const own = await harness({
      yaml: factory(
        SLACK,
        entry('tidy', call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')),
      ),
    });
    const [automation] = parseFactorySpec(
      factory(
        SLACK,
        entry('tidy', call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')),
      ),
    ).automations;
    // No agent, no action, no server: the slice-1 version.
    expect(versionOf(own, 'tidy')).toBe(automationVersion(automation));
  });

  it('keeps a one-step tool’s version where factory.yml defines servers', async () => {
    const h = await harness({
      yaml: factory(
        SLACK,
        '  - name: clean-up-stale-sessions\n    on: { cron: "0 9 * * 1-5" }\n    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }\n    mode: confirm\n',
      ),
    });
    expect(row(h, 'clean-up-stale-sessions').problem).toBeUndefined();
    // `versionPins.test.ts`' pin for the GRAMMAR example and the shipped template.
    expect(versionOf(h, 'clean-up-stale-sessions')).toBe('5ec4f18deeec55b9');
  });
});

describe('a dry run of an entry that calls a server (5a-2 Task 6, review S11)', () => {
  const notify = (dryRun: 'run' | 'report') =>
    factory(
      SLACK,
      `  - name: brief\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: notify\n    steps:\n${call('post', 'slack#chat_post_message', '{ channel: C0SUPPORT1, text: Weekly. }', `        dry_run: ${dryRun}\n`)}`,
    );

  it('asks until accepted when its call runs in a dry run, and not when it is reported', async () => {
    const runs = await harness({ yaml: notify('run') });
    expect(row(runs).asksFirst).toBe(true);
    const run = (await runs.service.trigger(WORKSPACE_ID, 'brief'))!;
    expect(runs.store.get(run.id)).toMatchObject({ status: 'needs-approval' });
    expect(runs.store.get(run.id)!.summary).toContain(
      'Approve once to let this new or changed automation run on its own.',
    );
    expect(row(await harness({ yaml: notify('report') })).asksFirst).toBeUndefined();
  });
});

describe("a call's server's secrets are the entry's (5a-2 Task 6)", () => {
  it('needs them bound, and Settings › Secrets says where each goes', async () => {
    const h = await harness({ secrets: {} });
    expect(row(h)).toMatchObject({
      problem: `needs \`SLACK_BOT_TOKEN\` bound ${BIND_HINT}`,
      unbound: ['SLACK_BOT_TOKEN'],
    });
    // Unbound, its server's uses are the ones the tab most needs.
    const use = {
      automation: 'brief',
      step: 'post',
      server: { name: 'slack', transport: 'stdio' },
    };
    expect(h.service.secretsView(WORKSPACE_ID)).toEqual([
      { name: 'SLACK_BOT_TOKEN', uses: [{ ...use, accepted: false }] },
    ]);
    h.world.secrets.bindings.set('SLACK_BOT_TOKEN', BOT_BINDING);
    await h.service.reload(WORKSPACE_ID);
    expect(row(h).problem).toBeUndefined();
    expect(h.service.secretsView(WORKSPACE_ID)).toMatchObject([
      { name: 'SLACK_BOT_TOKEN', uses: [{ ...use, accepted: false }] },
    ]);
    // An agent is told the name and whether it is bound: never where.
    expect(h.service.capabilities(WORKSPACE_ID).secrets).toEqual([
      { name: 'SLACK_BOT_TOKEN', bound: true },
    ]);
  });

  it('lists them for an entry with another problem too', async () => {
    const h = await harness({ mcp: { transports: ['http'] } });
    expect(row(h).problem).toBe(
      "this runner can't start stdio servers, so `uses: slack#…` can't run here",
    );
    expect(h.service.secretsView(WORKSPACE_ID)).toMatchObject([
      {
        name: 'SLACK_BOT_TOKEN',
        uses: [
          { automation: 'brief', step: 'post', server: { name: 'slack', transport: 'stdio' } },
        ],
      },
      { name: 'TRACKER_TOKEN', uses: [] },
    ]);
    // A problem with its trigger, found before its steps are looked at.
    const onEvent = await harness({
      yaml: factory(
        SLACK,
        BRIEF.replace(
          'on: { cron: "0 9 * * 1-5" }',
          'on: { github: pull_request.review_requested }',
        ),
      ),
    });
    expect(row(onEvent).problem).toMatch(/^scope: a github item runs in a worktree/);
    expect(onEvent.service.secretsView(WORKSPACE_ID)).toMatchObject([
      { name: 'SLACK_BOT_TOKEN', uses: [{ automation: 'brief', step: 'post' }] },
      { name: 'TRACKER_TOKEN', uses: [] },
    ]);
  });

  it('gives the Allow card its servers and calls', async () => {
    const h = await harness();
    expect(h.service.entryAgents(WORKSPACE_ID, 'brief')).toMatchObject({
      servers: [SLACK_DEFINITION],
      calls: [{ step: 'post', ref: 'slack#chat_post_message', server: 'slack' }],
    });
  });
});

describe('saving an entry that calls a server (5a-2 Task 6, Call 2)', () => {
  const lone = (steps: string) =>
    `- name: post-it\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n  mode: confirm\n  steps:\n${steps.replace(/^ {4}/gm, '')}`;
  const BROKEN = SLACK.replace('    secrets:', '    cwd: /tmp\n    secrets:');

  it('refuses one calling a server with problems of its own, or none of that name', async () => {
    const h = await harness({ yaml: factory(BROKEN, '') });
    await expect(
      h.service.saveEntry(
        WORKSPACE_ID,
        lone(call('post', 'slack#chat_post_message', '{ channel: C0SUPPORT1 }')),
        { replace: false },
      ),
    ).rejects.toThrow(
      "Not saved: its step `post` calls `slack`, which has problems of its own in factory.yml's `mcpServers:`; save it once they are fixed.",
    );
    await expect(
      h.service.saveEntry(
        WORKSPACE_ID,
        lone(call('post', 'jira#create_issue', '{ title: Shipped }')),
        { replace: false },
      ),
    ).rejects.toThrow(
      'Not saved: its step `post` calls `jira`, and factory.yml defines no such server.',
    );
  });

  it("saves a call of Consola's own tools though factory.yml writes a server called consola", async () => {
    const h = await harness({
      yaml: factory(`  consola:\n    command: ${SLACK_COMMAND}\n`, ''),
    });
    await expect(
      h.service.saveEntry(
        WORKSPACE_ID,
        lone(call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')),
        { replace: false },
      ),
    ).resolves.toMatchObject({ name: 'post-it' });
  });

  it("saves one calling nothing though a server is broken, and says the folder doesn't apply", async () => {
    const h = await harness({ yaml: factory(SLACK, BRIEF) });
    await h.setYaml(factory(BROKEN, BRIEF));
    const saved = await h.service.saveEntry(
      WORKSPACE_ID,
      lone('      - id: look\n        run: git log -1\n'),
      { replace: false },
    );
    // The server's own issue, and the step it keeps from running: the version before keeps running.
    expect(saved.notApplied?.issues).toEqual([
      'factory.yml:8: Consola decides where a server starts, and it is never a checkout',
      "factory.yml:20: `slack` has problems of its own in factory.yml's `mcpServers:`; this step runs once they are fixed",
    ]);
    expect(h.service.list(WORKSPACE_ID).map((view) => view.name)).not.toContain('post-it');
  });
});

describe('an entry that calls nothing (5a-2 Task 6)', () => {
  it('resolves exactly as it does on a runner with no MCP client', async () => {
    const yaml = factory(
      '',
      `  - name: notes\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: look\n        run: git log -1\n      - id: write\n        prompt: Write the notes.\n`,
    );
    const withClient = await harness({ yaml });
    const without = await harness({ yaml, mcp: 'none' });
    expect(JSON.stringify(row(withClient, 'notes'))).toBe(JSON.stringify(row(without, 'notes')));
    const a = (await withClient.service.trigger(WORKSPACE_ID, 'notes'))!;
    const b = (await without.service.trigger(WORKSPACE_ID, 'notes'))!;
    expect(JSON.stringify(withClient.service.getRunDefinition(a.id))).toBe(
      JSON.stringify(without.service.getRunDefinition(b.id)),
    );
    // Neither key is written for an entry that calls nothing.
    expect(withClient.service.getRunDefinition(a.id)).not.toHaveProperty('servers');
    expect(withClient.service.getRunDefinition(a.id)).not.toHaveProperty('calls');
  });
});

/*
 * Task 7: the executor, in process.
 */

function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

/** What a spied `cleanup_stale_sessions` was asked, and how it answers. */
interface Spy {
  runs: Array<{ args: unknown; context: EngineToolContext; atCall?: RunRecordLike }>;
  previews: unknown[];
  /** Its `run` waits for this while it is set. */
  gate?: Promise<void>;
  /** Its `run` throws this (after the gate). */
  throws?: unknown;
  /** What its `run` answers as `data`. */
  data?: unknown;
  /** Read at each `run`, before anything else: what the store holds then. */
  atCall?: () => RunRecordLike;
}
type RunRecordLike = ReturnType<StepsHarness['store']['get']>;

function spied(spy: Spy): TestTool {
  return defineTool({
    ...CLEAN_UP,
    preview: async (args) => {
      spy.previews.push(args);
      return { summary: 'Would clean up 2 sessions.', data: { sessions: 2 } };
    },
    run: async (args, context) => {
      spy.runs.push({ args, context, atCall: spy.atCall?.() });
      if (spy.gate) await spy.gate;
      if (spy.throws) throw spy.throws;
      return { summary: 'Cleaned up 2 sessions.', data: spy.data ?? { removed: 2 } };
    },
  });
}
const newSpy = (): Spy => ({ runs: [], previews: [] });
const others = TOOLS.filter((tool) => tool.name !== 'cleanup_stale_sessions');

/** One `uses: consola#cleanup_stale_sessions` step `clean`, then `steps` after it, on a schedule. */
const tidy = (
  mode: 'auto' | 'notify',
  withYaml = '{ pr_states: [merged] }',
  after = '',
  extra = '',
) =>
  factory(
    '',
    `  - name: tidy\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: ${mode}\n    steps:\n${call('clean', 'consola#cleanup_stale_sessions', withYaml, extra)}${after}`,
  );

/** A harness over `yaml` with the spy's tool, every entry's version accepted. */
async function accepted(yaml: string, spy: Spy, options: StepsHarnessOptions = {}) {
  const h = await harness({ yaml, tools: [spied(spy), ...others], ...options });
  for (const view of h.service.list(WORKSPACE_ID)) {
    const version = h.service.entryAgents(WORKSPACE_ID, view.name)?.version;
    if (version) h.store.accept(`${WORKSPACE_ID} ${view.name}`, version);
  }
  spy.atCall = () => structuredClone(h.store.runs()[0]);
  return h;
}
const attemptFile = (h: StepsHarness, runId: string, step: string, file: string) =>
  path.join(h.folder.attemptDir(WORKSPACE_ID, runId, step, 1), file);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const stepOf = (h: StepsHarness, runId: string, step: string) =>
  h.store.get(runId)!.steps!.find((record) => record.id === step)!;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a step calling Consola's own tool (5a-2 Task 7)", () => {
  it('calls it once, as the automation, with its intent on disk first, and keeps what it said', async () => {
    const spy = newSpy();
    const h = await accepted(tidy('auto'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(spy.runs).toHaveLength(1);
    expect(spy.runs[0].args).toEqual({ pr_states: ['merged'] });
    expect(spy.runs[0].context.caller).toEqual({ kind: 'automation', automation: 'tidy' });
    expect(spy.runs[0].context.scope.workspaceIds).toEqual([WORKSPACE_ID]);
    // Its intent was on the record before the tool was called.
    const atCall = spy.runs[0].atCall!.steps!.find((record) => record.id === 'clean')!;
    expect(atCall).toMatchObject({ kind: 'uses', status: 'running' });
    expect(atCall.call?.intentAt).toBeDefined();
    expect(h.store.get(run.id)).toMatchObject({ status: 'completed' });
    const record = stepOf(h, run.id, 'clean');
    expect(record).toMatchObject({
      kind: 'uses',
      status: 'completed',
      artifacts: [{ name: 'output', bytes: 13 }],
      call: { intentAt: atCall.call?.intentAt, landed: true, resultBytes: 13 },
    });
    expect(record.call?.resultAt).toBeDefined();
    expect(readJson(attemptFile(h, run.id, 'clean', 'output.json'))).toEqual({ removed: 2 });
    const detail = h.service.getStepDetail(run.id, 'clean')!;
    expect(detail.call).toEqual({
      server: 'consola',
      reached: "Consola's own tool, in process",
      tool: 'cleanup_stale_sessions',
      arguments: [{ name: 'pr_states', template: ['merged'], value: ['merged'], trust: 'literal' }],
    });
    expect(detail.result).toEqual({
      isError: false,
      bytes: 13,
      summary: 'Cleaned up 2 sessions.',
      result: { removed: 2 },
    });
  });

  it('in a dry run, previews it and calls nothing', async () => {
    const spy = newSpy();
    const h = await accepted(tidy('notify'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(spy.runs).toEqual([]);
    expect(spy.previews).toEqual([{ pr_states: ['merged'] }]);
    expect(stepOf(h, run.id, 'clean')).toMatchObject({ status: 'reported' });
    expect(stepOf(h, run.id, 'clean').call).toBeUndefined();
    expect(readJson(attemptFile(h, run.id, 'clean', 'call.json'))).toMatchObject({
      wouldHave: true,
      reached: "Consola's own tool, in process",
    });
    expect(readJson(attemptFile(h, run.id, 'clean', 'result.json'))).toMatchObject({
      summary: 'Would clean up 2 sessions.',
    });
  });

  it('fails with what the tool said when it throws, and says it may have acted', async () => {
    const spy = newSpy();
    spy.throws = new Error('boom');
    const h = await accepted(tidy('auto'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error: '`consola#cleanup_stale_sessions` failed: boom',
      call: { isError: true },
    });
  });

  it('refuses at run time a rendered value its tool does not take, and sends nothing', async () => {
    const spy = newSpy();
    const yaml = factory(
      '',
      entry(
        'sort',
        call(
          'clean',
          'consola#cleanup_stale_sessions',
          '{ pr_states: ["{{steps.triage.verdict}}"] }',
        ),
      ),
    );
    const h = await accepted(yaml, spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'sort'))!;
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    const record = stepOf(h, run.id, 'clean');
    expect(record.status).toBe('failed');
    expect(record.error).toMatch(/^with: pr_states\.0: .+\. Nothing was sent\.$/);
    expect(record.call?.intentAt).toBeUndefined();
    expect(spy.runs).toEqual([]);
  });
});

describe('a dry run of a call marked dry_run: run (5a-2 Task 7)', () => {
  it('runs it for real, as a dry run starts its marked commands', async () => {
    const listed: unknown[] = [];
    const lister = defineTool({
      ...LIST_THINGS,
      run: async (args) => {
        listed.push(args);
        return { summary: 'Listed.', data: { things: [] } };
      },
    });
    const yaml = factory(
      '',
      `  - name: look\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: notify\n    steps:\n${call('look', 'consola#list_things', '{ kind: open }', '        dry_run: run\n')}`,
    );
    const h = await harness({
      yaml,
      tools: [lister, ...TOOLS.filter((tool) => tool.name !== 'list_things')],
    });
    h.store.accept(`${WORKSPACE_ID} look`, h.service.entryAgents(WORKSPACE_ID, 'look')!.version);
    const run = (await h.service.trigger(WORKSPACE_ID, 'look'))!;
    await h.flush();
    expect(h.store.get(run.id)?.dryRun).toBe(true);
    expect(listed).toEqual([{ kind: 'open' }]);
    expect(stepOf(h, run.id, 'look')).toMatchObject({
      status: 'completed',
      call: { landed: true },
    });
  });
});

describe('a dry run of a server call (5a-2 Task 7)', () => {
  it('reports what it would send, with each argument’s trust, and starts nothing', async () => {
    const h = await harness({ yaml: factory(SLACK, entry('brief', POST, '    mode: notify\n')) });
    h.store.accept(`${WORKSPACE_ID} brief`, h.service.entryAgents(WORKSPACE_ID, 'brief')!.version);
    const run = (await h.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'Ship it.' });
    await h.world.endTurn('session-1');
    expect(stepOf(h, run.id, 'post')).toMatchObject({ status: 'reported' });
    expect(readJson(attemptFile(h, run.id, 'post', 'call.json'))).toEqual({
      server: 'slack',
      reached: `started \`${SLACK_COMMAND} --stdio\` on this Mac`,
      tool: 'chat_post_message',
      arguments: [
        { name: 'channel', template: 'C0SUPPORT1', value: 'C0SUPPORT1', trust: 'literal' },
        { name: 'text', template: '{{steps.triage.note}}', value: 'Ship it.', trust: 'untrusted' },
      ],
      wouldHave: true,
    });
    expect(h.world.mcp.launches).toEqual([]);
    // A dry run reads only what a `dry_run: run` step needs: none here.
    expect(h.world.secrets.resolved.flat()).not.toContain('SLACK_BOT_TOKEN');
  });
});

describe('run: { tool }, on the same executor (5a-2 Task 7, M4)', () => {
  it('runs with its with: exactly as written, and records as it did', async () => {
    const seen: unknown[] = [];
    const echo = defineTool({
      name: 'echo_args',
      description: 'Answers with its arguments.',
      input: { note: z.string() },
      mutating: false,
      automatable: true,
      run: async (args) => {
        seen.push(args);
        return { summary: 'Echoed.', data: args };
      },
    });
    const yaml = factory(
      '',
      '  - name: echo\n    on: { cron: "0 9 * * 1-5" }\n    run: { tool: consola#echo_args, with: { note: "{{item.key}}" } }\n    mode: auto\n',
    );
    const h = await harness({ yaml, tools: [echo] });
    h.store.accept(`${WORKSPACE_ID} echo`, h.service.entryAgents(WORKSPACE_ID, 'echo')!.version);
    const run = (await h.service.trigger(WORKSPACE_ID, 'echo'))!;
    await h.flush();
    expect(seen).toEqual([{ note: '{{item.key}}' }]);
    const record = h.store.get(run.id)!;
    expect(record).toMatchObject({ status: 'completed', actionName: 'consola#echo_args' });
    expect(record.steps).toBeUndefined();
    expect(record.result).toEqual({ note: '{{item.key}}' });
  });
});

describe("a call's slot, stop, quit and timeout (5a-2 Task 7, Calls 10, 21, 27)", () => {
  const QUIET = `  - name: quiet\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: look\n        run: git log -1\n`;

  it('holds the command slot while it runs', async () => {
    const spy = newSpy();
    const gate = held();
    spy.gate = gate.promise;
    const h = await accepted(factory('', tidy('auto').split('automations:\n')[1], QUIET), spy, {
      maxConcurrentCommands: 1,
    });
    const first = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(stepOf(h, first.id, 'clean').status).toBe('running');
    await h.service.trigger(WORKSPACE_ID, 'quiet');
    await h.flush();
    expect(h.world.commands).toEqual([]);
    gate.release();
    await h.flush();
    expect(stepOf(h, first.id, 'clean').status).toBe('completed');
    expect(h.world.commands).toHaveLength(1);
  });

  it('a stop aborts its signal and settles it at once; what it returns later is dropped', async () => {
    const spy = newSpy();
    const gate = held();
    spy.gate = gate.promise;
    const h = await accepted(tidy('auto'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    h.service.stop(run.id);
    await h.flush();
    const signal = spy.runs[0].context.signal!;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('stop');
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error:
        'It may or may not have happened: it was stopped while the call ran. Check, then retry.',
    });
    const ended = structuredClone(h.store.get(run.id));
    const lines = h.history.appends.length;
    gate.release();
    await h.flush();
    expect(h.store.get(run.id)).toEqual(ended);
    expect(h.history.appends).toHaveLength(lines);
    expect(fs.existsSync(attemptFile(h, run.id, 'clean', 'result.json'))).toBe(false);
    expect(fs.existsSync(attemptFile(h, run.id, 'clean', 'output.json'))).toBe(false);
  });

  it('its timeout aborts it, and says how long it waited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const spy = newSpy();
    spy.gate = held().promise;
    const h = await accepted(
      tidy('auto', '{ pr_states: [merged] }', '', '        timeout: 1s\n'),
      spy,
    );
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'clean').status).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    await h.flush();
    expect(spy.runs[0].context.signal!.aborted).toBe(true);
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error: 'It may or may not have happened: the call timed out after 1s. Check, then retry.',
    });
  });

  it('a quit aborts it with quit, and records nothing more: its intent stays', async () => {
    const spy = newSpy();
    const gate = held();
    spy.gate = gate.promise;
    const h = await accepted(tidy('auto'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    const lines = h.history.appends.length;
    h.service.shutdown();
    expect(spy.runs[0].context.signal!.reason).toBe('quit');
    gate.release();
    await h.flush();
    expect(h.history.appends).toHaveLength(lines);
    expect(stepOf(h, run.id, 'clean')).toMatchObject({ status: 'running' });
    expect(stepOf(h, run.id, 'clean').call?.intentAt).toBeDefined();
  });

  it('writes nothing once its run ended, or its workspace went (review S3)', async () => {
    const spy = newSpy();
    let gate = held();
    spy.gate = gate.promise;
    const h = await accepted(tidy('auto'), spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    fs.rmSync(path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json'));
    await h.service.syncWorkspaces();
    expect(h.store.get(run.id)?.status).toBe('failed');
    expect(spy.runs[0].context.signal!.aborted).toBe(true);
    const ended = structuredClone(h.store.get(run.id));
    const lines = h.history.appends.length;
    gate.release();
    await h.flush();
    expect(h.store.get(run.id)).toEqual(ended);
    expect(h.history.appends).toHaveLength(lines);
    expect(fs.existsSync(attemptFile(h, run.id, 'clean', 'result.json'))).toBe(false);

    const other = newSpy();
    gate = held();
    other.gate = gate.promise;
    const deleted = await accepted(tidy('auto'), other);
    const gone = (await deleted.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await deleted.flush();
    deleted.world.workspaceDeleted = true;
    await deleted.service.syncWorkspaces();
    expect(other.runs[0].context.signal!.aborted).toBe(true);
    gate.release();
    await deleted.flush();
    expect(deleted.store.get(gone.id)).toBeUndefined();
  });
});

describe('a write that fails before the intent (5a-2 Task 7)', () => {
  it('says nothing was sent, and calls nothing', async () => {
    const spy = newSpy();
    const h = await accepted(tidy('auto'), spy);
    const write = h.folder.writeJson.bind(h.folder);
    const once = vi.spyOn(h.folder, 'writeJson').mockImplementation((dir, file, value) => {
      if (file === 'call.json') throw new Error('read-only folder');
      write(dir, file, value);
    });
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error: 'Could not record what it would send (read-only folder). Nothing was sent.',
    });
    once.mockRestore();
    const intent = await accepted(tidy('auto'), spy);
    const durably = intent.store.updateDurably.bind(intent.store);
    vi.spyOn(intent.store, 'updateDurably').mockImplementation((runId, changes) => {
      if (changes.steps?.some((record) => record.call?.intentAt)) throw new Error('disk full');
      return durably(runId, changes);
    });
    const second = (await intent.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await intent.flush();
    expect(stepOf(intent, second.id, 'clean')).toMatchObject({
      status: 'failed',
      error: 'Could not record that it was about to call (disk full). Nothing was sent.',
    });
    expect(spy.runs).toEqual([]);
  });
});

describe('a throw after the intent (5a-2 Task 7, review S4)', () => {
  it('says it may have happened when the answer could not be recorded', async () => {
    const spy = newSpy();
    const h = await accepted(tidy('auto'), spy);
    const durably = h.store.updateDurably.bind(h.store);
    vi.spyOn(h.store, 'updateDurably').mockImplementation((runId, changes) => {
      if (changes.steps?.some((record) => record.call?.resultAt)) throw new Error('disk full');
      return durably(runId, changes);
    });
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error: 'It may or may not have happened: disk full. Check, then retry.',
    });
    expect(spy.runs).toHaveLength(1);
  });

  it('says it happened when only its result file could not be written', async () => {
    const spy = newSpy();
    const h = await accepted(tidy('auto'), spy);
    const write = h.folder.writeJson.bind(h.folder);
    vi.spyOn(h.folder, 'writeJson').mockImplementation((dir, file, value) => {
      if (file === 'result.json') throw new Error('read-only folder');
      write(dir, file, value);
    });
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    const record = stepOf(h, run.id, 'clean');
    expect(record).toMatchObject({
      status: 'failed',
      error: 'It happened, but Consola could not record its result (read-only folder).',
      call: { landed: true },
    });
    expect(record.call?.resultAt).toBeDefined();
    expect(record.error).not.toContain('Nothing was sent');
  });
});

describe('a call whose with: has no value yet (5a-2 Task 7, review Minor 5)', () => {
  it('skips it on a first run, and the run goes on', async () => {
    const yaml = factory(
      '',
      `  - name: notes\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: brief\n        prompt: Write it.\n${call('look', 'consola#list_things', '{ kind: "{{previous.brief.handover}}" }')}      - id: tail\n        run: git log -1\n`,
    );
    const h = await accepted(yaml, newSpy());
    const run = (await h.service.trigger(WORKSPACE_ID, 'notes'))!;
    await h.flush();
    h.world.writeArtifact('session-1', 'handover', 'Notes.');
    await h.world.endTurn('session-1');
    expect(stepOf(h, run.id, 'look')).toMatchObject({
      status: 'skipped',
      skipped:
        'with: previous.brief.handover has no value: There is no earlier run of this automation on this item.',
    });
    expect(h.world.commands).toHaveLength(1);
  });
});

describe('an in-run Consola tool beside its run (5a-2 Task 7, review Minor 14)', () => {
  it("never acts on the run's own sessions", async () => {
    const spy = newSpy();
    const yaml = factory(
      '',
      `  - name: tidy-pr\n    on: manual\n    applies_to: [pr]\n    steps:\n      - id: triage\n        prompt: Triage it.\n${call('clean', 'consola#cleanup_stale_sessions', '{ pr_states: [merged] }')}`,
    );
    const h = await accepted(yaml, spy);
    const run = (await h.service.trigger(
      WORKSPACE_ID,
      'tidy-pr',
      {},
      {
        workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' },
      },
    ))!;
    // A run on an item a person picks asks first (`confirm`).
    await h.service.approve(run.id);
    await h.flush();
    await h.world.endTurn('session-1');
    expect(spy.runs).toHaveLength(1);
    expect(spy.runs[0].context.scope.excludeSessionIds).toContain('session-1');
  });
});

describe("a command reading a call's output (5a-2 Task 7, review S6)", () => {
  it('gets its text, and its file', async () => {
    const spy = newSpy();
    const yaml = tidy(
      'auto',
      '{ pr_states: [merged] }',
      '      - id: after\n        run: echo "$OUT" "$OUT_FILE"\n        env: { OUT: "{{steps.clean.output}}", OUT_FILE: "{{steps.clean.output.file}}" }\n',
    );
    const h = await accepted(yaml, spy);
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(h.world.commands).toHaveLength(1);
    expect(h.world.commands[0].spec.env.OUT).toBe('{"removed":2}');
    expect(h.world.commands[0].spec.env.OUT_FILE).toBe(
      attemptFile(h, run.id, 'clean', 'output.json'),
    );
  });
});

/*
 * Task 8: the executor, against a server (the fake client: nothing starts).
 */

/** `slack`'s tool, as the spec's server lists it. */
const CHAT_POST: FakeServer['tools'][number] = {
  name: 'chat_post_message',
  inputSchema: {
    type: 'object',
    properties: { channel: { type: 'string' }, text: { type: 'string' } },
  },
  outputSchema: { type: 'object', properties: { ts: { type: 'string' } } },
};
const TS = '1700000484.000100';
const POSTED: McpCallOutcome = {
  kind: 'answered',
  isError: false,
  structuredContent: { ok: true, ts: TS, channel: 'C0SUPPORT1' },
  content: [{ type: 'text', text: `{"ok":true,"ts":"${TS}"}` }],
  bytes: 64,
};
const GROUP = { pgid: 4242, startedAt: 'Mon Nov 16 08:00:00 2026' };

/** A fake `slack` that lists `chat_post_message` and answers `answer` (default: posted). */
const slack = (fields: Partial<FakeServer> = {}): FakeServer => ({
  tools: [CHAT_POST],
  group: GROUP,
  answer: () => POSTED,
  ...fields,
});

/** `brief` accepted, with `slack` as given; fired, its triage done: `post` has run, or waits. */
async function posting(
  server: FakeServer = slack(),
  options: StepsHarnessOptions & { note?: string } = {},
) {
  const h = await harness({ mcp: { servers: { slack: server } }, ...options });
  for (const view of h.service.list(WORKSPACE_ID)) {
    const version = h.service.entryAgents(WORKSPACE_ID, view.name)?.version;
    if (version) h.store.accept(`${WORKSPACE_ID} ${view.name}`, version);
  }
  const run = (await h.service.trigger(WORKSPACE_ID, 'brief'))!;
  await h.flush();
  h.world.setOutputs('session-1', { verdict: 'post', note: options.note ?? 'Ship it.' });
  await h.world.endTurn('session-1');
  return { h, run, post: () => stepOf(h, run.id, 'post') };
}

describe('a call of a factory server (5a-2 Task 8)', () => {
  it('reaches it with the run’s values, records its group and intent before the send, keeps its answer', async () => {
    const { h, run, post } = await posting();
    // 5a-1's gate read the server's secret before the first step.
    expect(h.world.secrets.resolved[0]).toContain('SLACK_BOT_TOKEN');
    expect(h.world.mcp.launches).toHaveLength(1);
    const [launch] = h.world.mcp.launches;
    expect(launch).toMatchObject({
      transport: 'stdio',
      name: 'slack',
      command: SLACK_COMMAND,
      args: ['--stdio'],
      env: { SLACK_TEAM_ID: 'T0SPROCKET', SLACK_BOT_TOKEN: BOT_VALUE },
      logPath: attemptFile(h, run.id, 'post', 'server.log'),
      timeoutMs: 60_000,
    });
    // Its group was on the record before initialize, and its intent before the send.
    expect(h.world.mcp.initialized).toEqual([GROUP]);
    expect(h.world.mcp.calls).toEqual([
      {
        server: 'slack',
        tool: 'chat_post_message',
        args: { channel: 'C0SUPPORT1', text: 'Ship it.' },
        intentAt: expect.any(String),
        group: GROUP,
      },
    ]);
    expect(post()).toMatchObject({
      status: 'completed',
      outputs: { ts: TS },
      artifacts: [{ name: 'output', bytes: expect.any(Number) }],
      call: { server: { ...GROUP, ended: true }, landed: true, resultBytes: 64 },
    });
    expect(post().call?.intentAt).toBeDefined();
    expect(post().call?.resultAt).toBeDefined();
    for (const file of ['call.json', 'result.json', 'output.json']) {
      expect(fs.existsSync(attemptFile(h, run.id, 'post', file)), file).toBe(true);
    }
    expect(h.world.mcp.closes).toEqual(['slack']);
    expect(h.store.get(run.id)?.status).toBe('completed');
  });

  it("caps connecting at 2 minutes, whatever the step's timeout (review Minor 19)", async () => {
    const yaml = factory(
      SLACK,
      entry('brief', POST.replace('        outputs:', '        timeout: 10m\n        outputs:')),
    );
    const { h } = await posting(slack(), { yaml });
    expect(h.world.mcp.launches[0].timeoutMs).toBe(120_000);
  });
});

describe('every row of the Failure table (5a-2 Task 8)', () => {
  it.each<[string, Partial<FakeServer>, string]>([
    [
      'a connect refused',
      { refuse: { reason: 'spawn npx ENOENT' } },
      "Couldn't reach `slack`: spawn npx ENOENT. Nothing was sent.",
    ],
    [
      'a whole reason',
      {
        refuse: {
          reason:
            'The server answered with a redirect to `https://evil.example`; Consola does not follow redirects. Point `url` at the final address.',
          whole: true,
        },
      },
      'The server answered with a redirect to `https://evil.example`; Consola does not follow redirects. Point `url` at the final address. Nothing was sent.',
    ],
    [
      'no such tool',
      { tools: [{ name: 'conversations_history' }] },
      '`slack` has no tool `chat_post_message` (it has: conversations_history). Nothing was sent.',
    ],
    [
      'arguments that do not fit',
      { argumentsProblem: '/channel must be string' },
      'with: /channel must be string. Nothing was sent.',
    ],
    [
      'an output its schema lacks',
      {
        tools: [
          {
            ...CHAT_POST,
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        ],
      },
      "`slack#chat_post_message`'s output schema has no `ts`. Nothing was sent.",
    ],
  ])('%s: nothing was sent', async (_name, fields, error) => {
    const { h, post } = await posting(slack(fields));
    expect(post()).toMatchObject({ status: 'failed', error });
    expect(post().call?.intentAt).toBeUndefined();
    expect(h.world.mcp.calls).toEqual([]);
    // A session it reached is closed before it settles.
    expect(h.world.mcp.closes).toEqual(fields.refuse ? [] : ['slack']);
  });

  it('lists at most 20 of the tools a server has when it lacks the one called', async () => {
    const tools = Array.from({ length: 25 }, (_, index) => ({ name: `tool_${index + 1}` }));
    const { post } = await posting(slack({ tools }));
    expect(post().error).toBe(
      `\`slack\` has no tool \`chat_post_message\` (it has: ${tools
        .slice(0, 20)
        .map((tool) => tool.name)
        .join(', ')}, …). Nothing was sent.`,
    );
  });

  it('records what it left running, and that it was ended', async () => {
    const { post } = await posting(slack({ survivors: 2 }));
    expect(post()).toMatchObject({
      status: 'completed',
      call: { server: { ...GROUP, ended: true }, survivors: 2 },
    });
  });

  it("refuses a header whose secret's value holds a line break, and reaches nothing", async () => {
    const yaml = factory(
      SLACK + TRACKER,
      entry('brief', call('file', 'tracker#create_issue', '{ title: Shipped }')),
    );
    const { h, run } = await posting(slack(), {
      yaml,
      secrets: { ...BOUND, values: { ...BOUND.values, TRACKER_TOKEN: 'v\r\nX-Evil: 1' } },
      mcp: { servers: { tracker: { tools: [{ name: 'create_issue' }] } } },
    });
    expect(stepOf(h, run.id, 'file')).toMatchObject({
      status: 'failed',
      error:
        "Couldn't use `TRACKER_TOKEN` in a header: its value holds a line break. Nothing was sent.",
    });
    expect(h.world.mcp.launches).toEqual([]);
  });

  it('records no group for a run that ended while its server was being spawned', async () => {
    const spawning = held();
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    h.world.mcp.spawnGate = spawning.promise;
    h.store.accept(`${WORKSPACE_ID} brief`, h.service.entryAgents(WORKSPACE_ID, 'brief')!.version);
    const run = (await h.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    fs.rmSync(path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json'));
    await h.service.syncWorkspaces();
    const ended = structuredClone(h.store.get(run.id));
    spawning.release();
    await h.flush();
    expect(h.store.get(run.id)).toEqual(ended);
    expect(stepOf(h, run.id, 'post').call?.server).toBeUndefined();
  });

  it('a failed intent write sends nothing and closes the session', async () => {
    const h0 = await harness({ mcp: { servers: { slack: slack() } } });
    const durably = h0.store.updateDurably.bind(h0.store);
    vi.spyOn(h0.store, 'updateDurably').mockImplementation((runId, changes) => {
      if (changes.steps?.some((record) => record.call?.intentAt)) throw new Error('disk full');
      return durably(runId, changes);
    });
    h0.store.accept(
      `${WORKSPACE_ID} brief`,
      h0.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    const run = (await h0.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h0.flush();
    h0.world.setOutputs('session-1', { verdict: 'post', note: 'Ship it.' });
    await h0.world.endTurn('session-1');
    expect(stepOf(h0, run.id, 'post')).toMatchObject({
      status: 'failed',
      error: 'Could not record that it was about to call (disk full). Nothing was sent.',
      call: { server: { ...GROUP, ended: true } },
    });
    expect(h0.world.mcp.calls).toEqual([]);
    expect(h0.world.mcp.closes).toEqual(['slack']);
  });

  it('an error result fails it, says it may have acted, and nothing calls it again (review B2)', async () => {
    const { h, run, post } = await posting(
      slack({
        answer: () => ({
          kind: 'answered',
          isError: true,
          content: [{ type: 'text', text: 'rate_limited after post' }],
          bytes: 40,
        }),
      }),
    );
    expect(post()).toMatchObject({
      status: 'failed',
      error: '`slack#chat_post_message` failed: rate_limited after post',
      call: { isError: true },
    });
    expect(h.world.mcp.calls).toHaveLength(1);
    await h.tick();
    expect(h.world.mcp.calls).toHaveLength(1);
    const again = await h.relaunch();
    await again.tick();
    expect(again.world.mcp.calls).toHaveLength(1);
    expect(again.store.get(run.id)?.status).toBe('failed');
  });

  it.each([
    ['timeout', 'the call timed out after 1m'],
    ['stopped', 'it was stopped while the call ran'],
    ['closed', 'the server closed the connection before answering'],
    ['too-large', 'its answer was over 8 MB'],
    ['unreadable', 'its answer could not be read (no JSON)'],
  ] as const)('no clean answer (%s) may or may not have happened', async (why, words) => {
    const { post } = await posting(
      slack({ answer: () => ({ kind: 'unanswered', why, detail: 'no JSON' }) }),
    );
    expect(post()).toMatchObject({
      status: 'failed',
      error: `It may or may not have happened: ${words}. Check, then retry.`,
    });
    expect(post().call?.landed).toBeUndefined();
    expect(post().call?.intentAt).toBeDefined();
  });

  it('a landed call whose result lacks an output fails as landed', async () => {
    const { post } = await posting(
      slack({ answer: () => ({ ...POSTED, structuredContent: { ok: true } }) }),
    );
    expect(post()).toMatchObject({
      status: 'failed',
      error: 'It happened, but its result has no `ts`.',
      call: { landed: true },
    });
  });
});

describe('a stop, a quit and a run that ends, mid-call (5a-2 Task 8)', () => {
  it('a stop cancels the call, and one while connecting sends nothing', async () => {
    const gate = held();
    const { h, run, post } = await posting(
      slack({
        answer: async () => {
          await gate.promise;
          return POSTED;
        },
      }),
    );
    expect(post().status).toBe('running');
    h.service.stop(run.id);
    await h.flush();
    expect(h.world.mcp.callSignals[0].reason).toBe('stop');
    expect(post()).toMatchObject({
      status: 'failed',
      error:
        'It may or may not have happened: it was stopped while the call ran. Check, then retry.',
    });

    const connecting = held();
    const second = await harness({ mcp: { servers: { slack: slack() } } });
    second.world.mcp.connectGate = connecting.promise;
    second.store.accept(
      `${WORKSPACE_ID} brief`,
      second.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    const other = (await second.service.trigger(WORKSPACE_ID, 'brief'))!;
    await second.flush();
    second.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await second.world.endTurn('session-1');
    second.service.stop(other.id);
    await second.flush();
    expect(stepOf(second, other.id, 'post')).toMatchObject({
      status: 'failed',
      error: 'It was stopped before the call was sent. Nothing was sent.',
    });
    expect(second.world.mcp.calls).toEqual([]);
  });

  it('a quit aborts with quit and records nothing more (review S5)', async () => {
    const gate = held();
    const { h, post } = await posting(
      slack({
        answer: async () => {
          await gate.promise;
          return POSTED;
        },
      }),
    );
    const lines = h.history.appends.length;
    h.service.shutdown();
    await h.flush();
    expect(h.world.mcp.callSignals[0].reason).toBe('quit');
    gate.release();
    await h.flush();
    expect(h.history.appends).toHaveLength(lines);
    expect(post()).toMatchObject({ status: 'running', call: { server: GROUP } });
    expect(post().call?.intentAt).toBeDefined();
  });

  it('writes nothing once its run ended or its workspace went, and closes the session (review S3)', async () => {
    let gate = held();
    // An answer already on its way when the run ended: it still arrives.
    const waiting = () =>
      slack({
        answersThroughAbort: true,
        answer: async () => {
          await gate.promise;
          return POSTED;
        },
      });
    const { h, run } = await posting(waiting());
    fs.rmSync(path.join(h.folder.runDir(WORKSPACE_ID, run.id), 'definition.json'));
    await h.service.syncWorkspaces();
    expect(h.store.get(run.id)?.status).toBe('failed');
    const ended = structuredClone(h.store.get(run.id));
    const lines = h.history.appends.length;
    gate.release();
    await h.flush();
    expect(h.store.get(run.id)).toEqual(ended);
    expect(h.history.appends).toHaveLength(lines);
    expect(fs.existsSync(attemptFile(h, run.id, 'post', 'result.json'))).toBe(false);
    expect(h.world.mcp.closes).toEqual(['slack']);

    gate = held();
    const deleted = await posting(waiting());
    deleted.h.world.workspaceDeleted = true;
    await deleted.h.service.syncWorkspaces();
    gate.release();
    await deleted.h.flush();
    expect(deleted.h.store.get(deleted.run.id)).toBeUndefined();
    expect(deleted.h.world.mcp.closes).toEqual(['slack']);
  });
});

describe("a call's secrets and its run's snapshot (5a-2 Task 8, review S8, Minor 10)", () => {
  it('gives each server only its own secrets', async () => {
    const yaml = factory(
      SLACK + TRACKER,
      entry(
        'brief',
        `      - id: page\n        run: page --now\n        secrets: [PAGER_TOKEN]\n${POST}${call('file', 'tracker#create_issue', '{ title: Shipped }')}`,
      ),
    );
    const secrets = {
      bindings: { ...BOUND.bindings, PAGER_TOKEN: { ref: 'keychain:pager' } },
      values: { ...BOUND.values, PAGER_TOKEN: 'stub-pager-secret-7b2d' },
    };
    const { h } = await posting(slack(), {
      yaml,
      secrets,
      mcp: { servers: { slack: slack(), tracker: { tools: [{ name: 'create_issue' }] } } },
    });
    await h.world.commands[0].end();
    expect(h.world.mcp.launches.map((launch) => launch.name)).toEqual(['slack', 'tracker']);
    expect(h.world.mcp.launches[0]).toMatchObject({
      env: { SLACK_TEAM_ID: 'T0SPROCKET', SLACK_BOT_TOKEN: BOT_VALUE },
    });
    const [stdio, http] = h.world.mcp.launches;
    expect(stdio.transport === 'stdio' && stdio.env).toEqual({
      SLACK_TEAM_ID: 'T0SPROCKET',
      SLACK_BOT_TOKEN: BOT_VALUE,
    });
    expect(http.transport === 'http' && http.headers).toEqual({
      Authorization: `Bearer ${TRACKER_VALUE}`,
    });
  });

  it("reads and launches with the run's own server, not the factory's current one", async () => {
    // A run on an item a person picks: its checkout is prepared before its first step reads its secrets.
    const onItem = (server: string) =>
      factory(
        server,
        `  - name: brief\n    on: manual\n    applies_to: [pr]\n    steps:\n      - id: triage\n        prompt: Triage it.\n        outputs: { verdict: { enum: [post, skip] }, note: string }\n${POST}`,
      );
    const h = await harness({
      yaml: onItem(SLACK),
      mcp: { servers: { slack: slack() } },
      secrets: {
        bindings: { ...BOUND.bindings, SLACK_APP_TOKEN: { ref: 'keychain:app' } },
        values: { ...BOUND.values, SLACK_APP_TOKEN: 'stub-slack-app-secret-3f8e' },
      },
    });
    const preparing = held();
    h.world.checkouts.gate = preparing.promise;
    const run = (await h.service.trigger(
      WORKSPACE_ID,
      'brief',
      {},
      {
        workItem: { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' },
      },
    ))!;
    await h.service.approve(run.id);
    await h.flush();
    await h.setYaml(onItem(SLACK.replace('[SLACK_BOT_TOKEN]', '[SLACK_APP_TOKEN]')));
    h.world.checkouts.gate = undefined;
    preparing.release();
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    expect(h.world.secrets.resolved.flat()).toContain('SLACK_BOT_TOKEN');
    expect(h.world.secrets.resolved.flat()).not.toContain('SLACK_APP_TOKEN');
    const [launch] = h.world.mcp.launches;
    expect(launch.transport === 'stdio' && launch.env.SLACK_BOT_TOKEN).toBe(BOT_VALUE);
    expect(stepOf(h, run.id, 'post').status).toBe('completed');
  });
});

describe('a throw after a server call’s intent (5a-2 Task 8, review S4)', () => {
  it('says it happened when its result file could not be written, and may have when the answer could not be recorded', async () => {
    const h1 = await harness({ mcp: { servers: { slack: slack() } } });
    const write = h1.folder.writeJson.bind(h1.folder);
    vi.spyOn(h1.folder, 'writeJson').mockImplementation((dir, file, value) => {
      if (file === 'result.json') throw new Error('read-only folder');
      write(dir, file, value);
    });
    h1.store.accept(
      `${WORKSPACE_ID} brief`,
      h1.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    const one = (await h1.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h1.flush();
    h1.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h1.world.endTurn('session-1');
    const landed = stepOf(h1, one.id, 'post');
    expect(landed).toMatchObject({
      status: 'failed',
      error: 'It happened, but Consola could not record its result (read-only folder).',
      call: { landed: true },
    });
    expect(landed.call?.resultAt).toBeDefined();
    expect(h1.world.mcp.calls).toHaveLength(1);
    vi.restoreAllMocks();

    const h2 = await harness({ mcp: { servers: { slack: slack() } } });
    const durably = h2.store.updateDurably.bind(h2.store);
    vi.spyOn(h2.store, 'updateDurably').mockImplementation((runId, changes) => {
      if (changes.steps?.some((record) => record.call?.resultAt)) throw new Error('disk full');
      return durably(runId, changes);
    });
    h2.store.accept(
      `${WORKSPACE_ID} brief`,
      h2.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    const two = (await h2.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h2.flush();
    h2.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h2.world.endTurn('session-1');
    expect(stepOf(h2, two.id, 'post')).toMatchObject({
      status: 'failed',
      error: 'It may or may not have happened: disk full. Check, then retry.',
    });
    expect(stepOf(h2, two.id, 'post').error).not.toContain('Nothing was sent');
    expect(h2.world.mcp.calls).toHaveLength(1);
  });
});

describe('a server that echoes its credential (5a-2 Task 8, Review Focus 1)', () => {
  const forms = maskFormsOf(BOT_VALUE);
  const leaks = (h: StepsHarness, runId: string) => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) walk(file);
        else {
          const text = fs.readFileSync(file, 'utf8');
          if (forms.some((form) => text.includes(form))) found.push(file);
        }
      }
    };
    walk(h.folder.runDir(WORKSPACE_ID, runId));
    const record = JSON.stringify(h.store.get(runId));
    if (forms.some((form) => record.includes(form))) found.push('the record');
    for (const notice of h.notices) {
      if (forms.some((form) => `${notice.title} ${notice.body}`.includes(form))) {
        found.push('a notice');
      }
    }
    return found;
  };

  it('keeps none of its forms in what it writes, whatever the answer holds', async () => {
    const quoted = JSON.stringify(BOT_VALUE);
    const pct = encodeURIComponent(BOT_VALUE);
    const b64 = Buffer.from(BOT_VALUE).toString('base64');
    const errorRun = await posting(
      slack({
        answer: () => ({
          kind: 'answered',
          isError: true,
          content: [{ type: 'text', text: `bad token ${BOT_VALUE}` }],
          bytes: 50,
        }),
      }),
    );
    expect(errorRun.post().error).toBe('`slack#chat_post_message` failed: bad token ***');
    expect(leaks(errorRun.h, errorRun.run.id)).toEqual([]);

    const refused = await posting(slack({ refuse: { reason: `bad token ${BOT_VALUE}` } }));
    expect(refused.post().error).toBe("Couldn't reach `slack`: bad token ***. Nothing was sent.");
    expect(leaks(refused.h, refused.run.id)).toEqual([]);

    const yaml = factory(
      SLACK,
      entry('brief', POST.replace('outputs: { ts: string }', 'outputs: { echoed: string }')),
    );
    const echoing = await posting(
      slack({
        tools: [{ ...CHAT_POST, outputSchema: undefined }],
        answer: () => ({
          kind: 'answered',
          isError: false,
          structuredContent: { echoed: BOT_VALUE, quoted, pct, b64, [BOT_VALUE]: 1 },
          content: [{ type: 'text', text: `${BOT_VALUE} ${quoted} ${pct} ${b64}` }],
          bytes: 500,
        }),
      }),
      { yaml },
    );
    expect(echoing.post()).toMatchObject({ status: 'completed', outputs: { echoed: '***' } });
    expect(leaks(echoing.h, echoing.run.id)).toEqual([]);
    const result = readJson(attemptFile(echoing.h, echoing.run.id, 'post', 'result.json'));
    expect(result.result.structuredContent).toMatchObject({
      echoed: '***',
      quoted: '"***"',
      '***': 1,
    });
    expect(readJson(attemptFile(echoing.h, echoing.run.id, 'post', 'output.json'))).toMatchObject({
      echoed: '***',
    });

    const texts = await posting(
      slack({
        tools: [{ ...CHAT_POST, outputSchema: undefined }],
        answer: () => ({
          kind: 'answered',
          isError: false,
          content: [{ type: 'text', text: `${BOT_VALUE} ${quoted} ${pct} ${b64}` }],
          bytes: 300,
        }),
      }),
      {
        yaml: factory(SLACK, entry('brief', POST.replace('        outputs: { ts: string }\n', ''))),
      },
    );
    expect(texts.post().status).toBe('completed');
    expect(leaks(texts.h, texts.run.id)).toEqual([]);
  });
});

describe('a result too big or the wrong shape (5a-2 Task 8, Review Focus 3)', () => {
  it('keeps a 2 MB answer cut, writes no output, and a step that needs it fails', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const yaml = factory(
      SLACK,
      entry(
        'brief',
        `${POST.replace('        outputs: { ts: string }\n', '')}      - id: after\n        run: echo "$OUT"\n        env: { OUT: "{{steps.post.output}}" }\n`,
      ),
    );
    const { h, run, post } = await posting(
      slack({
        tools: [{ ...CHAT_POST, outputSchema: undefined }],
        answer: () => ({
          kind: 'answered',
          isError: false,
          content: [{ type: 'text', text: big }],
          bytes: big.length + 40,
        }),
      }),
      { yaml },
    );
    expect(post()).toMatchObject({ status: 'completed', call: { landed: true } });
    expect(post().artifacts).toBeUndefined();
    const result = readJson(attemptFile(h, run.id, 'post', 'result.json'));
    expect(result.result).toBeUndefined();
    expect(result.cut.length).toBe(1024 * 1024);
    expect(h.world.commands).toEqual([]);
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'steps.post.output has no value: post completed without it',
    });
  });

  it('two text blocks with an output declared: it landed, and has no ts', async () => {
    const { post } = await posting(
      slack({
        tools: [{ ...CHAT_POST, outputSchema: undefined }],
        answer: () => ({
          kind: 'answered',
          isError: false,
          content: [
            { type: 'text', text: `{"ts":"${TS}"}` },
            { type: 'text', text: 'and more' },
          ],
          bytes: 60,
        }),
      }),
    );
    expect(post()).toMatchObject({
      status: 'failed',
      error: 'It happened, but its result has no `ts`.',
      call: { landed: true },
    });
  });
});

describe('a server that never gets going, engine side (5a-2 Task 8, Review Focus 2)', () => {
  it('fails with the reach words, and the group it spawned is recorded ended', async () => {
    const { h, post } = await posting(
      slack({ refuse: { reason: 'it did not answer initialize within 60s' } }),
    );
    expect(post()).toMatchObject({
      status: 'failed',
      error: "Couldn't reach `slack`: it did not answer initialize within 60s. Nothing was sent.",
      call: { server: { ...GROUP, ended: true } },
    });
    expect(post().call?.intentAt).toBeUndefined();
    expect(h.world.mcp.calls).toEqual([]);
  });
});

describe('an agent asked for the run (5a-2 Task 8, decided by the user 11a)', () => {
  it('starts the server its card showed once, and accepts nothing', async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    const run = (await h.service.trigger(WORKSPACE_ID, 'brief', { sessionId: 'session-agent' }))!;
    expect(h.store.get(run.id)).toMatchObject({ status: 'needs-approval' });
    expect(h.store.get(run.id)!.summary).toContain(
      'An agent asked for this run: approving runs this run only.',
    );
    await h.service.approve(run.id);
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    expect(h.world.mcp.launches).toHaveLength(1);
    expect(h.world.mcp.calls).toHaveLength(1);
    expect(h.store.acceptedVersion(`${WORKSPACE_ID} brief`)).toBeUndefined();
    expect(row(h).asksFirst).toBe(true);
  });
});

describe("a call's values go with its run (5a-2 Task 8)", () => {
  it('holds none once the run ended, and leaves no session open', async () => {
    const { h, run } = await posting();
    expect(h.store.get(run.id)?.status).toBe('completed');
    const held = (h.service as unknown as { runSecrets: { held(id: string): unknown } }).runSecrets;
    expect(held.held(run.id)).toBeUndefined();
    expect(h.world.mcp.closes).toHaveLength(h.world.mcp.launches.length);
  });
});

/*
 * Task 9: restarts, servers left running, and Check server.
 */

describe('a quit mid-call, then a start (5a-2 Task 9, Review Focus 4)', () => {
  const inFlight = (fields: Partial<FakeServer> = {}) => {
    const gate = held();
    return slack({
      answer: async () => {
        await gate.promise;
        return POSTED;
      },
      ...fields,
    });
  };

  it('fails the step, ends the group it recorded, and never calls the tool again', async () => {
    const { h, run } = await posting(inFlight());
    expect(stepOf(h, run.id, 'post').call).toMatchObject({ server: GROUP });
    const again = await h.relaunch();
    await again.flush();
    expect(stepOf(again, run.id, 'post')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_CALL,
    });
    expect(again.world.mcp.orphans).toEqual([GROUP]);
    expect(stepOf(again, run.id, 'post').call?.server).toEqual({ ...GROUP, ended: true });
    expect(again.world.mcp.launches).toHaveLength(1);
    expect(again.world.mcp.calls).toHaveLength(1);
  });

  it('marks one that is gone ended, and leaves one it cannot tell about', async () => {
    const gone = await posting(inFlight());
    gone.h.world.mcp.orphanAnswer = 'gone';
    const after = await gone.h.relaunch();
    await after.flush();
    expect(stepOf(after, gone.run.id, 'post').call?.server).toEqual({ ...GROUP, ended: true });

    const unknown = { pgid: 4243, startedAt: '' };
    const blind = await posting(inFlight({ group: unknown }));
    blind.h.world.mcp.orphanAnswer = 'unknown';
    const next = await blind.h.relaunch();
    await next.flush();
    expect(next.world.mcp.orphans).toEqual([unknown]);
    expect(stepOf(next, blind.run.id, 'post').call?.server).toEqual(unknown);
  });

  it('a retry starts the server again, on a new attempt that shows nothing of the one before', async () => {
    const { h, run } = await posting(inFlight());
    const again = await h.relaunch();
    await again.flush();
    again.world.mcp.servers.set('slack', slack({ refuse: { reason: 'spawn npx ENOENT' } }));
    await again.service.retry(run.id);
    await again.flush();
    const retried = stepOf(again, run.id, 'post');
    expect(retried).toMatchObject({ attempt: 2, status: 'failed' });
    expect(retried.error).toBe("Couldn't reach `slack`: spawn npx ENOENT. Nothing was sent.");
    expect(retried.call?.intentAt).toBeUndefined();
    expect(retried.call?.resultAt).toBeUndefined();
    expect(retried.call?.server).toEqual({ ...GROUP, ended: true });
    expect(again.world.mcp.launches).toHaveLength(2);
  });

  it('a retry whose connect spawns nothing keeps no group of the attempt before', async () => {
    const { h, run } = await posting(inFlight());
    const again = await h.relaunch();
    await again.flush();
    again.world.mcp.servers.set(
      'slack',
      slack({ group: undefined, refuse: { reason: 'spawn npx ENOENT' } }),
    );
    await again.service.retry(run.id);
    await again.flush();
    const retried = stepOf(again, run.id, 'post');
    expect(retried.attempt).toBe(2);
    expect(retried.call).toBeUndefined();
  });

  it('a quit while connecting aborts it with quit and records nothing more', async () => {
    const connecting = held();
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    h.world.mcp.connectGate = connecting.promise;
    h.store.accept(`${WORKSPACE_ID} brief`, h.service.entryAgents(WORKSPACE_ID, 'brief')!.version);
    await h.service.trigger(WORKSPACE_ID, 'brief');
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    const lines = h.history.appends.length;
    h.service.shutdown();
    await h.flush();
    expect(h.world.mcp.launches[0].signal.reason).toBe('quit');
    expect(h.history.appends).toHaveLength(lines);
    expect(h.world.mcp.calls).toEqual([]);
  });
});

describe('Check server (5a-2 Task 9)', () => {
  const versionOf = (h: StepsHarness, name = 'brief') =>
    h.service.entryAgents(WORKSPACE_ID, name)!.version;
  const TOOLS_LISTED = [CHAT_POST, { name: 'conversations_history' }];

  it('starts the server once, lists its tools, calls none and accepts nothing', async () => {
    const h = await harness({ mcp: { servers: { slack: slack({ tools: TOOLS_LISTED }) } } });
    const view = await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
    expect(view).toEqual({
      server: 'slack',
      at: h.now().toISOString(),
      tools: ['chat_post_message', 'conversations_history'],
      steps: [{ step: 'post', tool: 'chat_post_message', verdict: 'fits' }],
    });
    expect(h.world.mcp.launches).toHaveLength(1);
    expect(h.world.mcp.launches[0]).toMatchObject({ name: 'slack', timeoutMs: 60_000 });
    expect(h.world.mcp.calls).toEqual([]);
    expect(h.world.mcp.closes).toEqual(['slack']);
    expect(row(h).servers).toEqual([
      expect.objectContaining({ name: 'slack', transport: 'stdio', lastCheck: view }),
    ]);
    expect(h.store.acceptedVersion(`${WORKSPACE_ID} brief`)).toBeUndefined();
    expect(h.store.runs()).toEqual([]);
    // Its group was in the ledger while it lived, and is gone once it was ended.
    expect(h.world.serverGroups.stored?.groups).toEqual([]);
  });

  it('refuses a stale version, a server the entry does not use, and a second press', async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    await expect(h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', 'v-old')).rejects.toThrow(
      CHECK_STALE,
    );
    await expect(
      h.service.checkServer(WORKSPACE_ID, 'brief', 'tracker', versionOf(h)),
    ).rejects.toThrow('`brief` does not use a server called `tracker`.');
    expect(h.world.mcp.launches).toEqual([]);
    const gate = held();
    h.world.mcp.connectGate = gate.promise;
    const first = h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
    await h.flush();
    await expect(
      h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h)),
    ).rejects.toThrow('`slack` is being checked already.');
    gate.release();
    await first;
    expect(h.world.mcp.launches).toHaveLength(1);
  });

  it("refuses where the runner can't start the server, and an entry that cannot run", async () => {
    const httpOnly = await harness({
      mcp: { servers: { slack: slack() }, transports: ['http'] },
    });
    await expect(
      httpOnly.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(httpOnly)),
    ).rejects.toThrow(
      "brief cannot run: this runner can't start stdio servers, so `uses: slack#…` can't run here",
    );
    expect(httpOnly.world.mcp.launches).toEqual([]);
    const unbound = await harness({ mcp: { servers: { slack: slack() } }, secrets: {} });
    await expect(
      unbound.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(unbound)),
    ).rejects.toThrow(`brief cannot run: needs \`SLACK_BOT_TOKEN\` bound ${BIND_HINT}`);
    expect(row(unbound).servers).toBeUndefined();
    expect(unbound.world.mcp.launches).toEqual([]);
  });

  it("gives each server on the entry's view the version Check server is for, and moves it with an edit", async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    const first = versionOf(h);
    expect(row(h).servers).toEqual([expect.objectContaining({ name: 'slack', version: first })]);
    // What the page sends back is accepted; after an edit, the view's new version is.
    await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', row(h).servers![0].version);
    await h.setYaml(factory(SLACK.replace('[--stdio]', '[--stdio, -v]'), BRIEF));
    const second = versionOf(h);
    expect(second).not.toBe(first);
    expect(row(h).servers).toEqual([expect.objectContaining({ name: 'slack', version: second })]);
    await expect(h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', first)).rejects.toThrow(
      CHECK_STALE,
    );
    await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', row(h).servers![0].version);
    expect(h.world.mcp.launches).toHaveLength(2);
  });

  it('says why when a secret does not read, and starts nothing', async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    h.world.secrets.resolveThrows = new Error('the keychain is locked');
    const view = await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
    expect(view.problem).toBe("Couldn't read its secrets: the keychain is locked");
    expect(h.world.mcp.launches).toEqual([]);
  });

  it("ends a refused server's group from the ledger, and says what it left running", async () => {
    const refused = await harness({
      mcp: { servers: { slack: slack({ refuse: { reason: 'it exited at once' } }) } },
    });
    const view = await refused.service.checkServer(
      WORKSPACE_ID,
      'brief',
      'slack',
      versionOf(refused),
    );
    expect(view).toEqual({
      server: 'slack',
      at: refused.now().toISOString(),
      steps: [],
      problem: "Couldn't reach `slack`: it exited at once.",
    });
    expect(refused.world.serverGroups.stored?.groups).toEqual([]);
    const lingering = await harness({ mcp: { servers: { slack: slack({ survivors: 1 }) } } });
    expect(
      await lingering.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(lingering)),
    ).toMatchObject({ survivors: 1 });
  });

  it('gives connecting the largest timeout of its calls, at most 2 minutes', async () => {
    const yaml = factory(
      SLACK,
      entry('brief', POST.replace('        outputs:', '        timeout: 10m\n        outputs:')),
    );
    const h = await harness({ yaml, mcp: { servers: { slack: slack() } } });
    await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
    expect(h.world.mcp.launches[0].timeoutMs).toBe(120_000);
  });

  it("says why when a header's secret holds a line break, and starts nothing", async () => {
    const yaml = factory(
      SLACK + TRACKER,
      entry('track', call('file', 'tracker#create_issue', '{ title: Shipped }')),
    );
    const h = await harness({
      yaml,
      secrets: { ...BOUND, values: { ...BOUND.values, TRACKER_TOKEN: 'v\r\nX-Evil: 1' } },
      mcp: { servers: { tracker: { tools: [{ name: 'create_issue' }] } } },
    });
    const view = await h.service.checkServer(
      WORKSPACE_ID,
      'track',
      'tracker',
      versionOf(h, 'track'),
    );
    expect(view.problem).toBe(
      "Couldn't use `TRACKER_TOKEN` in a header: its value holds a line break. Nothing was sent.",
    );
    expect(h.world.mcp.launches).toEqual([]);
  });

  it('is offered in every mode', async () => {
    for (const mode of ['confirm', 'notify'] as const) {
      const yaml = factory(SLACK, entry('brief', POST, `    mode: ${mode}\n`));
      const h = await harness({ yaml, mcp: { servers: { slack: slack() } } });
      const view = await h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
      expect(view.steps).toEqual([{ step: 'post', tool: 'chat_post_message', verdict: 'fits' }]);
    }
  });

  it('a check a quit cut off leaves its group in the ledger, and the next start ends it', async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    const gate = held();
    h.world.mcp.connectGate = gate.promise;
    void h.service.checkServer(WORKSPACE_ID, 'brief', 'slack', versionOf(h));
    await h.flush();
    expect(h.world.serverGroups.stored?.groups).toEqual([
      { ...GROUP, for: `${WORKSPACE_ID}/brief/slack`, at: h.now().toISOString() },
    ]);
    h.world.mcp.connectGate = undefined;
    const again = await h.relaunch();
    // The quit ended the check's server at once.
    expect(h.world.mcp.launches[0].signal.reason).toBe('quit');
    await again.flush();
    expect(again.world.mcp.orphans).toEqual([GROUP]);
    expect(again.world.serverGroups.stored?.groups).toEqual([]);
    gate.release();
  });

  it('keeps a ledger entry the client could not tell about', async () => {
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    h.world.serverGroups.stored = {
      version: 1,
      groups: [{ pgid: 4243, startedAt: '', for: `${WORKSPACE_ID}/brief/slack`, at: 'x' }],
    };
    h.world.mcp.orphanAnswer = 'unknown';
    const again = await h.relaunch();
    await again.flush();
    expect(again.world.mcp.orphans).toEqual([{ pgid: 4243, startedAt: '' }]);
    expect(again.world.serverGroups.stored?.groups).toHaveLength(1);
  });
});

/*
 * Review B1: a call is a step in the command lane like a command. The line
 * waits for its start only; its end settles it on its own, so a slow server
 * never holds every other run on the Mac.
 */
describe('the line while a call runs (review B1)', () => {
  /** One agent step (the agent lane). */
  const SECOND = `  - name: second\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: think\n        prompt: Think.\n`;
  /** One command (the command lane). */
  const THIRD = `  - name: third\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: look\n        run: git log -1\n`;

  /** A call (Consola's own tool, or `slack`'s) running and held until `gate` is released, with `second` and `third` beside it. */
  async function holding(target: 'consola' | 'server', options: StepsHarnessOptions = {}) {
    const gate = held();
    if (target === 'consola') {
      const spy = newSpy();
      spy.gate = gate.promise;
      const yaml = factory('', tidy('auto').split('automations:\n')[1], SECOND, THIRD);
      const h = await accepted(yaml, spy, options);
      const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
      await h.flush();
      return { h, gate, call: () => stepOf(h, run.id, 'clean') };
    }
    const answer = async () => {
      await gate.promise;
      return POSTED;
    };
    const yaml = factory(SLACK, BRIEF, SECOND, THIRD);
    const { h, post } = await posting(slack({ answer }), { yaml, ...options });
    return { h, gate, call: post };
  }

  /** Catches every rejection nothing handled, for the rest of the test. */
  function escapes(): unknown[] {
    const escaped: unknown[] = [];
    const listener = (reason: unknown) => escaped.push(reason);
    process.on('unhandledRejection', listener);
    onTestFinished(() => {
      process.off('unhandledRejection', listener);
    });
    return escaped;
  }

  it.each(['consola', 'server'] as const)(
    'lets an agent step and a command start while a %s call is held',
    async (target) => {
      const { h, gate, call } = await holding(target);
      expect(call().status).toBe('running');
      const second = (await h.service.trigger(WORKSPACE_ID, 'second'))!;
      const third = (await h.service.trigger(WORKSPACE_ID, 'third'))!;
      await h.flush();
      expect(stepOf(h, second.id, 'think')).toMatchObject({
        status: 'running',
        sessionId: expect.any(String),
      });
      expect(stepOf(h, third.id, 'look').status).toBe('running');
      expect(h.world.commands).toHaveLength(1);
      // Both started while the call was still held.
      expect(call().status).toBe('running');
      gate.release();
      await h.flush();
      expect(call().status).toBe('completed');
    },
  );

  it.each(['consola', 'server'] as const)(
    "counts a held %s call in the command lane's cap, while the agent lane goes on",
    async (target) => {
      const { h, gate, call } = await holding(target, { maxConcurrentCommands: 1 });
      const second = (await h.service.trigger(WORKSPACE_ID, 'second'))!;
      const third = (await h.service.trigger(WORKSPACE_ID, 'third'))!;
      await h.flush();
      // The line went on past the call: the agent step started.
      expect(stepOf(h, second.id, 'think').status).toBe('running');
      // The command waits for the slot the call holds.
      expect(h.store.get(third.id)?.status).toBe('queued');
      expect(h.world.commands).toEqual([]);
      gate.release();
      await h.flush();
      expect(call().status).toBe('completed');
      expect(stepOf(h, third.id, 'look').status).toBe('running');
      expect(h.world.commands).toHaveLength(1);
    },
  );

  it('fails the run of a call that throws once it started, and nothing escapes (in process)', async () => {
    const escaped = escapes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = newSpy();
    const h = await accepted(tidy('auto'), spy);
    const attemptDir = h.folder.attemptDir.bind(h.folder);
    vi.spyOn(h.folder, 'attemptDir').mockImplementation((ws, runId, step, attempt) => {
      if (step === 'clean') throw new Error('the run folder went away');
      return attemptDir(ws, runId, step, attempt);
    });
    const run = (await h.service.trigger(WORKSPACE_ID, 'tidy'))!;
    await h.flush();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'the run folder went away',
    });
    expect(stepOf(h, run.id, 'clean')).toMatchObject({
      status: 'failed',
      error: 'the run folder went away',
    });
    expect(spy.runs).toEqual([]);
    expect(escaped).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(run.id));
  });

  it('fails the run of a server call that throws past its answer, masked, ends its server, and nothing escapes', async () => {
    const escaped = escapes();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An adapter that breaks its word: `call` never rejects.
    const { h, run, post } = await posting(
      slack({
        answer: () => {
          throw new Error(`the adapter broke its word over ${BOT_VALUE}`);
        },
      }),
    );
    await h.flush();
    expect(h.store.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'the adapter broke its word over ***',
    });
    expect(post()).toMatchObject({
      status: 'failed',
      error: 'the adapter broke its word over ***',
    });
    expect(post().call?.intentAt).toBeDefined();
    // Its server is ended: the call's signal, which its connection follows, was aborted.
    expect(h.world.mcp.callSignals[0].reason).toBe('stop');
    expect(escaped).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(BOT_VALUE);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(run.id));
  });

  it('records nothing for a call that throws after a quit, or after its run ended', async () => {
    const escaped = escapes();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let gate = held();
    const throwing = () =>
      slack({
        answersThroughAbort: true,
        answer: async () => {
          await gate.promise;
          throw new Error('the adapter broke its word');
        },
      });
    const quit = await posting(throwing());
    expect(quit.post().status).toBe('running');
    quit.h.service.shutdown();
    const lines = quit.h.history.appends.length;
    const before = structuredClone(quit.h.store.get(quit.run.id));
    gate.release();
    await quit.h.flush();
    expect(quit.h.store.get(quit.run.id)).toEqual(before);
    expect(quit.h.history.appends).toHaveLength(lines);

    gate = held();
    const ended = await posting(throwing());
    fs.rmSync(path.join(ended.h.folder.runDir(WORKSPACE_ID, ended.run.id), 'definition.json'));
    await ended.h.service.syncWorkspaces();
    expect(ended.h.store.get(ended.run.id)?.status).toBe('failed');
    const failed = structuredClone(ended.h.store.get(ended.run.id));
    const endedLines = ended.h.history.appends.length;
    const notices = ended.h.notices.length;
    gate.release();
    await ended.h.flush();
    expect(ended.h.store.get(ended.run.id)).toEqual(failed);
    expect(ended.h.history.appends).toHaveLength(endedLines);
    expect(ended.h.notices).toHaveLength(notices);
    expect(escaped).toEqual([]);
  });
});

/*
 * Review S1: a server's definition in full on every view a card or Check
 * server's dialog reads (its literal `env:` and headers, a secret's header
 * as its template), and never a secret's value.
 */
describe("a server's literals on its views, never a value (review S1)", () => {
  const PROXIED = SLACK.replace(
    'env: { SLACK_TEAM_ID: T0SPROCKET }',
    'env: { SLACK_TEAM_ID: T0SPROCKET, HTTPS_PROXY: "http://elsewhere:8080" }',
  );
  const FORWARDED = TRACKER.replace(
    'headers: { Authorization: "Bearer ${TRACKER_TOKEN}" }',
    'headers: { Authorization: "Bearer ${TRACKER_TOKEN}", X-Forward-To: "https://elsewhere.example/hook" }',
  );
  const BOTH = entry(
    'brief',
    `${POST}${call('track', 'tracker#create_ticket', '{ title: "{{steps.triage.note}}" }')}`,
  );
  const TICKET = { name: 'create_ticket', inputSchema: { type: 'object' as const } };

  it('shows the literals, and no form of a bound value, while a call holds them and after a check', async () => {
    const gate = held();
    const answer = async () => {
      await gate.promise;
      return POSTED;
    };
    const { h, run, post } = await posting(slack({ answer }), {
      yaml: factory(PROXIED + FORWARDED, BOTH),
      mcp: {
        servers: {
          slack: slack({ answer }),
          tracker: { tools: [TICKET], answer: () => POSTED },
        },
      },
    });
    // The call runs: the run holds both values now.
    expect(post().status).toBe('running');
    expect(h.world.mcp.launches[0]).toMatchObject({ env: { SLACK_BOT_TOKEN: BOT_VALUE } });
    const check = await h.service.checkServer(
      WORKSPACE_ID,
      'brief',
      'tracker',
      h.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    const servers = row(h).servers!;
    expect(servers.find((server) => server.name === 'slack')?.env).toEqual([
      { name: 'SLACK_TEAM_ID', value: 'T0SPROCKET' },
      { name: 'HTTPS_PROXY', value: 'http://elsewhere:8080' },
    ]);
    expect(servers.find((server) => server.name === 'tracker')?.headers).toEqual([
      { name: 'Authorization', value: 'Bearer ${TRACKER_TOKEN}' },
      { name: 'X-Forward-To', value: 'https://elsewhere.example/hook' },
    ]);
    const facts = h.service.entryAgents(WORKSPACE_ID, 'brief')!.calls!.map((call) => call.facts);
    expect(facts.map((each) => each?.env ?? each?.headers)).toEqual([
      servers.find((server) => server.name === 'slack')?.env,
      servers.find((server) => server.name === 'tracker')?.headers,
    ]);
    const views = JSON.stringify([
      h.service.list(WORKSPACE_ID),
      h.service.snapshot(WORKSPACE_ID),
      h.service.entryAgents(WORKSPACE_ID, 'brief'),
      h.service.getRunDefinition(run.id),
      h.service.getStepDetail(run.id, 'post'),
      check,
    ]);
    for (const form of [...maskFormsOf(BOT_VALUE), ...maskFormsOf(TRACKER_VALUE)]) {
      expect(views).not.toContain(form);
    }
    gate.release();
    await h.flush();
  });
});

/*
 * Review M1: a retried call starts with no `call` of the attempt before it,
 * so a stop before it starts says nothing about a call it never made.
 */
describe('a retried call before it starts (review M1)', () => {
  it("keeps none of the earlier attempt's call, and a stop while it waits says only that it never started", async () => {
    const { h, run, post } = await posting(
      slack({
        answer: () => ({
          kind: 'answered',
          isError: true,
          content: [{ type: 'text', text: 'rate_limited after post' }],
          bytes: 40,
        }),
      }),
    );
    expect(post().call?.isError).toBe(true);
    // The command lane is full, so the retried call waits in line.
    h.world.maxConcurrentCommands = 0;
    await h.service.retry(run.id, 'post');
    await h.flush();
    expect(post()).toMatchObject({ status: 'queued', attempt: 2 });
    expect(post().call).toBeUndefined();
    h.service.stop(run.id);
    await h.flush();
    expect(post()).toMatchObject({
      status: 'failed',
      error: 'Stopped before post started.',
      attempt: 2,
    });
    expect(post().call).toBeUndefined();
    // Nothing was sent again.
    expect(h.world.mcp.calls).toHaveLength(1);
  });
});

/*
 * Review M3: the sweep's answer for a group an earlier start left lands
 * late (`ps` is slow); by then the step may have started again with a group
 * of its own, which the answer must not mark ended.
 */
describe('a late answer for a group an earlier start left (review M3)', () => {
  it("marks ended only the group it was handed, never the one the step's new attempt recorded", async () => {
    const connecting = held();
    const h = await harness({ mcp: { servers: { slack: slack() } } });
    h.world.mcp.connectGate = connecting.promise;
    h.store.accept(`${WORKSPACE_ID} brief`, h.service.entryAgents(WORKSPACE_ID, 'brief')!.version);
    const run = (await h.service.trigger(WORKSPACE_ID, 'brief'))!;
    await h.flush();
    h.world.setOutputs('session-1', { verdict: 'post', note: 'n' });
    await h.world.endTurn('session-1');
    // Quit while connecting: its group is recorded, its intent is not.
    expect(stepOf(h, run.id, 'post').call).toEqual({ server: GROUP });
    const NEWER = { pgid: 5151, startedAt: 'Mon Nov 16 09:00:00 2026' };
    h.world.mcp.servers.set('slack', slack({ group: NEWER }));
    const sweep = held();
    h.world.mcp.orphanGate = sweep.promise;
    const again = await h.relaunch();
    await again.flush();
    // The start handed the old group to be ended, and the step, back in line, started again.
    expect(again.world.mcp.orphans).toEqual([GROUP]);
    expect(stepOf(again, run.id, 'post')).toMatchObject({
      status: 'running',
      call: { server: NEWER },
    });
    // Only now does the sweep answer for the old group.
    again.world.mcp.orphanGate = undefined;
    sweep.release();
    await again.flush();
    expect(stepOf(again, run.id, 'post').call?.server).toEqual(NEWER);
    again.world.mcp.connectGate = undefined;
    connecting.release();
    await again.flush();
    expect(stepOf(again, run.id, 'post')).toMatchObject({
      status: 'completed',
      call: { server: { ...NEWER, ended: true } },
    });
  });
});

/*
 * Review M5: Check server masks the tool names it lists, as every other
 * string a check or a call takes from the server.
 */
describe("Check server's tool names (review M5)", () => {
  it('masks a value the server names a tool with', async () => {
    const h = await harness({
      mcp: { servers: { slack: slack({ tools: [CHAT_POST, { name: `echo_${BOT_VALUE}` }] }) } },
    });
    const view = await h.service.checkServer(
      WORKSPACE_ID,
      'brief',
      'slack',
      h.service.entryAgents(WORKSPACE_ID, 'brief')!.version,
    );
    expect(view.tools).toEqual(['chat_post_message', 'echo_***']);
    const shown = JSON.stringify([
      view,
      h.service.list(WORKSPACE_ID),
      h.service.snapshot(WORKSPACE_ID),
    ]);
    for (const form of maskFormsOf(BOT_VALUE)) expect(shown).not.toContain(form);
  });
});

describe("a call inside a repeat: loop (the merge with slice 3; the 5a-2 review's items 2 and 3)", () => {
  /** A daily entry whose only steps are a loop around one call of `ref`, until it answers `ts: done`. */
  const rounds = (
    ref = 'slack#chat_post_message',
    withYaml = '{ channel: C0SUPPORT1, text: hello }',
  ) =>
    `  - name: rounds\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: polish\n        repeat: { max: 2, until: "steps.post.ts == 'done'" }\n        steps:\n          - id: post\n            uses: ${ref}\n            with: ${withYaml}\n            outputs: { ts: string }\n`;
  const answering = (...ts: string[]): FakeServer => {
    let at = 0;
    return slack({
      answer: () => ({ ...POSTED, structuredContent: { ok: true, ts: ts[at++] } }),
    });
  };
  const acceptAll = (h: StepsHarness) => {
    for (const view of h.service.list(WORKSPACE_ID)) {
      const version =
        view.servers?.[0]?.version ?? h.service.entryAgents(WORKSPACE_ID, view.name)?.version;
      if (version) h.store.accept(`${WORKSPACE_ID} ${view.name}`, version);
    }
  };

  it('resolves it against its server and runs it once a round, each round its own attempt and call.json', async () => {
    const h = await harness({
      yaml: factory(SLACK, rounds()),
      mcp: { servers: { slack: answering('r1', 'done') } },
    });
    expect(row(h, 'rounds').problem).toBeUndefined();
    acceptAll(h);
    const run = (await h.service.trigger(WORKSPACE_ID, 'rounds'))!;
    await h.flush();
    await h.flush();
    const definition = h.service.getRunDefinition(run.id)!;
    expect(definition.servers).toEqual({ slack: SLACK_DEFINITION });
    expect(Object.keys(definition.calls ?? {})).toEqual(['post']);
    expect(h.world.mcp.calls).toHaveLength(2);
    expect(h.world.mcp.calls.every((sent) => sent.intentAt !== undefined)).toBe(true);
    expect(stepOf(h, run.id, 'post')).toMatchObject({
      status: 'completed',
      attempt: 2,
      outputs: { ts: 'done' },
    });
    for (const attempt of [1, 2]) {
      expect(
        fs.existsSync(
          path.join(h.folder.attemptDir(WORKSPACE_ID, run.id, 'post', attempt), 'call.json'),
        ),
      ).toBe(true);
    }
    expect(h.store.get(run.id)!.status).toBe('completed');
  });

  it("checks a loop's consola# call: a selector fed an untrusted value is the entry's problem", async () => {
    const tidy = (withYaml: string) =>
      `  - name: tidy\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: triage\n        prompt: Triage what came in.\n        outputs: { verdict: { enum: [post, skip] }, note: string }\n      - id: polish\n        repeat: { max: 2, until: "steps.clean.removed == 0" }\n        steps:\n          - id: clean\n            uses: consola#cleanup_stale_sessions\n            with: ${withYaml}\n            outputs: { removed: integer }\n`;
    expect(
      await problemOf(
        { yaml: factory(SLACK, tidy('{ session_ids: ["{{steps.triage.note}}"] }')) },
        'tidy',
      ),
    ).toBe(
      '`session_ids` chooses what `consola#cleanup_stale_sessions` acts on; it takes only trusted values',
    );
    expect(
      await problemOf({ yaml: factory(SLACK, tidy('{ pr_states: [merged] }')) }, 'tidy'),
    ).toBeUndefined();
  });

  it("needs a loop's server's secrets bound, and lists where they go", async () => {
    const unbound = await harness({
      yaml: factory(SLACK, rounds()),
      secrets: { bindings: {}, values: {} },
    });
    expect(row(unbound, 'rounds').problem).toBe(`needs \`SLACK_BOT_TOKEN\` bound ${BIND_HINT}`);
    const h = await harness({ yaml: factory(SLACK, rounds()) });
    const bot = h.service
      .snapshot(WORKSPACE_ID)
      .secrets!.find((view) => view.name === 'SLACK_BOT_TOKEN')!;
    expect(bot.uses).toContainEqual(
      expect.objectContaining({
        automation: 'rounds',
        step: 'post',
        server: { name: 'slack', transport: 'stdio' },
      }),
    );
  });

  it("Check server answers for a server only a loop calls, within its call's budget", async () => {
    const h = await harness({
      yaml: factory(SLACK, rounds()),
      mcp: { servers: { slack: slack({ tools: [CHAT_POST] }) } },
    });
    const version = row(h, 'rounds').servers![0].version;
    const view = await h.service.checkServer(WORKSPACE_ID, 'rounds', 'slack', version);
    expect(view).toEqual({
      server: 'slack',
      at: h.now().toISOString(),
      tools: ['chat_post_message'],
      steps: [{ step: 'post', tool: 'chat_post_message', verdict: 'fits' }],
    });
    expect(h.world.mcp.launches[0]).toMatchObject({ name: 'slack', timeoutMs: 60_000 });
  });

  it('refuses to save one whose loop calls a server with problems of its own', async () => {
    const BROKEN = SLACK.replace('    secrets:', '    cwd: /tmp\n    secrets:');
    const h = await harness({ yaml: factory(BROKEN, '') });
    const lone = rounds().replace(/^ {2}/gm, '');
    await expect(h.service.saveEntry(WORKSPACE_ID, lone, { replace: false })).rejects.toThrow(
      "Not saved: its step `post` calls `slack`, which has problems of its own in factory.yml's `mcpServers:`; save it once they are fixed.",
    );
  });
});

describe('a call where neither branch alone could see it (the merge with slice 3, brief item 4)', () => {
  const ROUNDS = factory(
    SLACK,
    `  - name: rounds\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: polish\n        repeat: { max: 2, until: "steps.post.ts == 'done'" }\n        steps:\n          - id: post\n            uses: slack#chat_post_message\n            with: { channel: C0SUPPORT1, text: hello }\n            outputs: { ts: string }\n`,
  );
  const acceptAll = (h: StepsHarness) => {
    for (const view of h.service.list(WORKSPACE_ID)) {
      const version =
        view.servers?.[0]?.version ?? h.service.entryAgents(WORKSPACE_ID, view.name)?.version;
      if (version) h.store.accept(`${WORKSPACE_ID} ${view.name}`, version);
    }
  };

  it("a quit while a loop's call is in flight fails it at the next start, with its loop, and never calls it again", async () => {
    const gate = held();
    const h = await harness({
      yaml: ROUNDS,
      mcp: {
        servers: {
          slack: slack({
            answer: async () => {
              await gate.promise;
              return POSTED;
            },
          }),
        },
      },
    });
    acceptAll(h);
    const run = (await h.service.trigger(WORKSPACE_ID, 'rounds'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'post').call?.intentAt).toBeDefined();
    const again = await h.relaunch();
    gate.release();
    await again.flush();
    await again.tick();
    expect(again.store.get(run.id)).toMatchObject({ status: 'failed', error: INTERRUPTED_CALL });
    expect(stepOf(again, run.id, 'post')).toMatchObject({
      status: 'failed',
      error: INTERRUPTED_CALL,
    });
    expect(stepOf(again, run.id, 'polish').status).toBe('failed');
    expect(again.world.mcp.calls).toHaveLength(1);
  });

  it('a gate before a call: the parked run holds no server, across a restart, and the answer reads the values again and calls once', async () => {
    const yaml = factory(
      SLACK,
      '  - name: gated\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    mode: auto\n    steps:\n      - id: decide\n        gate: { ask: Post it? }\n      - id: post\n        uses: slack#chat_post_message\n        with: { channel: C0SUPPORT1, text: hello }\n',
    );
    const h = await harness({ yaml, mcp: { servers: { slack: slack() } } });
    acceptAll(h);
    const run = (await h.service.trigger(WORKSPACE_ID, 'gated'))!;
    await h.flush();
    expect(h.store.get(run.id)!.status).toBe('waiting');
    expect(h.world.mcp.launches).toEqual([]);
    const again = await h.relaunch();
    await again.tick();
    expect(again.store.get(run.id)!.status).toBe('waiting');
    expect(again.world.mcp.launches).toEqual([]);
    expect(again.world.serverGroups.stored?.groups ?? []).toEqual([]);
    const reads = again.world.secrets.resolved.length;
    again.service.answerGate(run.id, 'decide', 'approve');
    await again.flush();
    expect(again.world.secrets.resolved.length).toBe(reads + 1);
    expect(again.world.secrets.resolved.at(-1)).toContain('SLACK_BOT_TOKEN');
    expect(again.world.mcp.calls).toHaveLength(1);
    expect(again.store.get(run.id)!.status).toBe('completed');
    await again.tick();
    expect(again.world.mcp.calls).toHaveLength(1);
  });

  it("in a run that owns its checkout, a call's server starts outside it, and only a command's step settles it", async () => {
    const yaml = `version: 1\nrepos: [sprocket/catalog-portal]\nmcpServers:\n${SLACK}automations:\n  - name: owned\n    on: manual\n    mode: auto\n    checkout: { repo: sprocket/catalog-portal, branch: "consola/run-{{run.id}}" }\n    steps:\n      - id: post\n        uses: slack#chat_post_message\n        with: { channel: C0SUPPORT1, text: hello }\n      - id: check\n        run: "true"\n`;
    const h = await harness({ yaml, runCheckouts: true, mcp: { servers: { slack: slack() } } });
    expect(row(h, 'owned').problem).toBeUndefined();
    acceptAll(h);
    const run = (await h.service.trigger(WORKSPACE_ID, 'owned'))!;
    await h.flush();
    expect(stepOf(h, run.id, 'post').status).toBe('completed');
    const dir = h.store.get(run.id)!.checkout!.cwd;
    expect(JSON.stringify(h.world.mcp.launches[0])).not.toContain(dir);
    const portCalls = () => h.world.runCheckouts.calls.map((call) => Object.keys(call)[0]);
    expect(portCalls()).not.toContain('settle');
    await h.world.commands[0].end();
    expect(portCalls()).toContain('settle');
    expect(h.store.get(run.id)!.status).toBe('completed');
  });
});
