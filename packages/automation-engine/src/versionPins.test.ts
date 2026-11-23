import {
  automationVersion,
  factoryFilesOf,
  parseAutomationEntry,
  parseFactory,
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
 * that moves one has changed what an existing file means (contract 14).
 * "Steps, on an event" and `review-assigned-prs` hash to `run.test.ts`'s
 * steps-template pin.
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
  it('every example and template hashes as it did when 2-B started', () => {
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
          "fb44316799ab00f5",
        ],
        [
          "A prompt, on a schedule",
          "a733c350d8b205c0",
        ],
        [
          "Steps, on an event",
          "6dfd57fa0f97c2ff",
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
          "c1616b18265e1061",
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
          "6dfd57fa0f97c2ff",
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
          "fb5d5b162f96759e",
        ],
        [
          "review-assigned-prs-gated",
          "d6c6eabaac1e1c69",
        ],
      ]
    `);
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
