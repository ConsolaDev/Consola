import {
  automationVersion,
  factoryFilesOf,
  parseAutomationEntry,
  parseFactory,
  serverHash,
  stableStringify,
  stepsResolvedBody,
} from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import { GRAMMAR_EXAMPLES } from './capabilities';
import { fileVersion } from './factory/apply';
import { AUTOMATION_TEMPLATES } from './templates';
import type { WorkspaceView } from './views';

/**
 * Agents as files changes how a version is hashed once a step names an agent
 * (spec *The version › Proof*): every example an agent is taught and every
 * template a person can add must hash exactly as they did before. These pins
 * were taken when phase 2-B started, before any factory-spec change; a task
 * that moves one has changed what an existing file means (contract 14). The
 * pins of the entries on an event moved once, by decision, when a
 * connection's trigger took its one form (`events:`, with the filter under
 * it); the others are 2-B's. "Steps, on an event" and `review-assigned-prs`
 * hash to `run.test.ts`'s steps-template pin.
 */

/** The workspace `templates.test.ts` builds, copied so these pins never move with that file. */
const SPROCKET: WorkspaceView = {
  id: 'ws-1',
  provider: { id: 'github', accountLogin: 'alice', org: 'sprocket' },
  actions: [
    {
      name: 'Review',
      appliesTo: ['pr'],
      prompt: 'Review the changes and summarise your findings.',
    },
  ],
  scopes: [{ id: 'scope-portal', name: 'catalog-portal', path: '/code/catalog-portal' }],
  sessions: [],
};

/**
 * An entry's version as the engine takes it, with every action's body
 * written as `BODY`: a `run: { action }` entry's body is the action's, and a
 * steps entry's is `{ <stepId>: <body> }` over the steps that name an action.
 */
function versionOf(entry: string): string {
  const parsed = parseAutomationEntry(entry);
  if (!parsed.ok) {
    throw new Error(`does not parse: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  }
  const { automation } = parsed;
  const actionSteps = (automation.steps ?? []).filter(
    (step) => step.kind === 'agent' && step.action !== undefined,
  );
  const body =
    automation.run?.kind === 'action'
      ? 'BODY'
      : actionSteps.length > 0
        ? stableStringify(Object.fromEntries(actionSteps.map((step) => [step.id, 'BODY'])))
        : undefined;
  return automationVersion(automation, body);
}

describe('versions before agents as files', () => {
  it('every example and template hashes as pinned', () => {
    expect(
      GRAMMAR_EXAMPLES.map((example) => [example.title, versionOf(example.entry)]),
    ).toMatchInlineSnapshot(`
      [
        [
          "A tool, on a schedule",
          "5ec4f18deeec55b9",
        ],
        [
          "An action, on an event",
          "121a47d3c78dcd16",
        ],
        [
          "A prompt, on a schedule",
          "a733c350d8b205c0",
        ],
        [
          "Steps, on an event",
          "1c68c1393bd9628e",
        ],
        [
          "Steps, on a poll",
          "9387227e150d8b94",
        ],
        [
          "Steps with a turn cap, on a schedule",
          "e5bfa2615d0f2688",
        ],
        [
          "A review loop with a gate, on an event",
          "3ab7dedc4111932a",
        ],
        [
          "A Jira bug to a pull request, in a sandbox",
          "e7c59dbce05c7185",
        ],
      ]
    `);
    expect(
      AUTOMATION_TEMPLATES.map((template) => [template.id, versionOf(template.entry(SPROCKET))]),
    ).toMatchInlineSnapshot(`
      [
        [
          "review-assigned-prs",
          "1c68c1393bd9628e",
        ],
        [
          "re-review-on-new-commits",
          "9387227e150d8b94",
        ],
        [
          "clean-up-stale-sessions",
          "5ec4f18deeec55b9",
        ],
        [
          "morning-inbox-digest",
          "519310bdd624b8d9",
        ],
        [
          "brief-review-requests",
          "bee95bb156c27865",
        ],
        [
          "review-assigned-prs-gated",
          "d2104377fef76a3f",
        ],
      ]
    `);
  });
});

describe('versions with secrets', () => {
  /** `text` with `insert` after its one `after`. */
  const withLine = (text: string, after: string, insert: string) => {
    expect(text.split(after)).toHaveLength(2);
    return text.replace(after, `${after}${insert}`);
  };

  it("a check's and a command's secrets move only the entries that write them", () => {
    const poll = GRAMMAR_EXAMPLES.find((example) => example.title === 'Steps, on a poll')!.entry;
    const steps = GRAMMAR_EXAMPLES.find((example) => example.title === 'Steps, on an event')!.entry;
    // The twins are the pins above.
    expect(versionOf(poll)).toBe('9387227e150d8b94');
    expect(versionOf(steps)).toBe('1c68c1393bd9628e');
    const pollWith = withLine(poll, '      changed: .head\n', '      secrets: [TRACKER_TOKEN]\n');
    const stepsWith = withLine(steps, '      dry_run: run\n', '      secrets: [PAGER_TOKEN]\n');
    expect(versionOf(pollWith)).not.toBe('9387227e150d8b94');
    expect(versionOf(stepsWith)).not.toBe('1c68c1393bd9628e');
    expect(versionOf(pollWith)).not.toBe(versionOf(stepsWith));
  });
});

describe('versions with servers (5a-2)', () => {
  it('a one-step tool hashes as it did, and a call holds its server’s definition', () => {
    // The GRAMMAR example and the shipped template: their pins above, unmoved.
    const tool = GRAMMAR_EXAMPLES.find((example) => example.title === 'A tool, on a schedule')!;
    expect(versionOf(tool.entry)).toBe('5ec4f18deeec55b9');
    // The spec's §4.3 post, with its brief as a prompt step (no agent file) and the spec's `slack`.
    const read = parseFactory(
      factoryFilesOf({
        'factory.yml': `version: 1
mcpServers:
  slack:
    description: Posts to Sprocket's Slack as the support bot.
    command: npx
    args: [-y, "@sprocket/slack-mcp@1.4.2"]
    secrets: [SLACK_BOT_TOKEN]
automations:
  - name: support-briefing
    on: { cron: "0 8 * * MON" }
    scope: support-notes
    mode: auto
    steps:
      - id: brief
        prompt: Write the 2nd-line briefing.
      - id: post
        uses: slack#chat_post_message
        with: { channel: "#support-2nd-line", text: "{{steps.brief.handover}}" }
        outputs: { ts: { type: string } }
`,
      }),
    );
    expect(read.issues).toEqual([]);
    const [briefing] = read.automations;
    const hashes = { slack: serverHash(read.servers.slack) };
    expect(hashes).toMatchInlineSnapshot(`
      {
        "slack": "6efdccd3ce2ca80c",
      }
    `);
    expect(
      automationVersion(briefing, stepsResolvedBody({}, {}, undefined, { servers: hashes })),
    ).toMatchInlineSnapshot(`"8650032de80a6a0c"`);
  });
});

/**
 * Slice 3-B's first pin: a run-owned entry with a write agent, its version
 * covering the agent's hash and its environment's. Taken when 3-B Task 6
 * landed; a later task that moves it changes what such a file means.
 */
describe('versions of write agents (slice 3-B)', () => {
  it('a run-owned entry with a write agent hashes with its environment', () => {
    const read = parseFactory(
      factoryFilesOf({
        'factory.yml':
          'version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n  - name: fix\n    on: manual\n    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{run.id}}" }\n    steps:\n      - id: fix\n        agent: fixer\n        prompt: Fix it.\n',
        'agents/fixer.md':
          '---\nharness: claude-work\ntools: write\nenvironment: sandboxed\n---\nFix it.\n',
        'environments/sandboxed.yaml': 'isolation: sandbox\nnetwork: [registry.npmjs.org]\n',
      }),
    );
    expect(read.issues).toEqual([]);
    const [fix] = read.automations;
    const version = automationVersion(
      fix,
      stepsResolvedBody(
        {},
        { fixer: read.agents.fixer.hash },
        { sandboxed: read.environments.sandboxed.hash },
      ),
    );
    expect(version).toBe('421215b867a8df04');
    expect(fileVersion(fix, read.agents, read.environments)).toBe(version);
  });
});
