import { describe, expect, it } from 'vitest';
import {
  parseAutomationEntry,
  PR_ITEM_NEEDS_PRS,
  type Automation,
  type RunRecord,
  type StepsAutomation,
} from '@consola/factory-spec';
import { entryCheckoutKind, entryReadsItems, prCheckoutProblem, runCheckoutKind } from './checkout';
import type { RunDefinition } from './definition';

/*
 * Whose checkout an entry's runs work in (the kind a host compiles an agent's
 * servers for), and, apart from it, whether those runs carry an item someone
 * else wrote (what the cards' item line says).
 */

const STEPS = '  steps:\n    - id: look\n      prompt: Look at it.\n';

function entry(head: string): Automation {
  const parsed = parseAutomationEntry(`- name: watch\n${head}${STEPS}`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return parsed.automation;
}

describe('entryCheckoutKind and entryReadsItems', () => {
  const rows: Array<[string, string, 'item' | 'scope', boolean]> = [
    ['an event entry', '  on: { github: pull_request.review_requested }\n', 'item', true],
    [
      'an event entry with scope:',
      '  on: { github: pull_request.review_requested }\n  scope: notes\n',
      'scope',
      true,
    ],
    [
      'a poll with item:',
      '  on:\n    poll: { every: 30m, run: ./list-prs, item: { github: .url } }\n',
      'item',
      true,
    ],
    [
      // North-star §4.2's investigator: its checkout is the scope's, and its alerts are someone else's text.
      'a poll with key: and scope:',
      '  on:\n    poll: { every: 1h, run: ./alerts, key: .id }\n  scope: api\n',
      'scope',
      true,
    ],
    ['on: manual with applies_to', '  on: manual\n  applies_to: [pr]\n', 'item', true],
    ['on: manual without', '  on: manual\n  scope: api\n', 'scope', false],
    ['a schedule', '  on: { cron: "0 9 * * 1-5" }\n  scope: api\n', 'scope', false],
  ];
  for (const [what, head, kind, reads] of rows) {
    it(`${what}: ${kind}, ${reads ? 'reads items' : 'reads none'}`, () => {
      const automation = entry(head);
      expect(entryCheckoutKind(automation)).toBe(kind);
      expect(entryReadsItems(automation)).toBe(reads);
    });
  }
});

describe('runCheckoutKind', () => {
  const scheduled = entry('  on: { cron: "0 9 * * 1-5" }\n  scope: api\n') as StepsAutomation;
  const onItems = entry('  on: { github: pull_request.review_requested }\n') as StepsAutomation;
  const definition = (automation: StepsAutomation, checkout?: 'item' | 'scope'): RunDefinition => ({
    automation,
    version: 'v',
    actions: {},
    ...(checkout ? { checkout } : {}),
  });
  const run = (changes: Partial<RunRecord> = {}): RunRecord => ({
    id: 'run-1',
    runner: 'local',
    source: 'personal',
    automationId: 'watch',
    actionName: 'steps',
    actionVersion: 'v',
    mode: 'auto',
    trigger: { kind: 'cron', at: '2026-11-22T09:00:00.000Z' },
    status: 'running',
    attribution: { automationId: 'watch', actionName: 'steps', triggerKind: 'cron' },
    createdAt: '2026-11-22T09:00:00.000Z',
    updatedAt: '2026-11-22T09:00:00.000Z',
    ...changes,
  });
  const onPr: Partial<RunRecord> = {
    trigger: {
      kind: 'event',
      at: '2026-11-22T09:00:00.000Z',
      connection: 'github',
      item: {
        key: 'github:sprocket/catalog-portal:pr:51',
        url: 'https://github.com/sprocket/catalog-portal/pull/51',
        title: 'Add retries',
        repo: 'sprocket/catalog-portal',
        number: 51,
        type: 'pr',
      },
    },
  };
  const head = { checkout: { cwd: '/worktrees/catalog-portal-pr-51', scopeId: 's', head: 'abc' } };

  it('a definition that says item is item, whatever the run says', () => {
    expect(runCheckoutKind(run(), definition(scheduled, 'item'))).toBe('item');
  });

  it('a recorded checkout with a head is item', () => {
    expect(runCheckoutKind(run(head), definition(scheduled))).toBe('item');
  });

  it('a definition that says scope never outvotes a recorded head', () => {
    expect(runCheckoutKind(run(head), definition(scheduled, 'scope'))).toBe('item');
  });

  it('an entry without scope and a run with a work item is item', () => {
    expect(runCheckoutKind(run(onPr), definition(onItems))).toBe('item');
  });

  it("a scheduled run in its scope's folder is scope", () => {
    expect(
      runCheckoutKind(
        run({ checkout: { cwd: '/code/api', scopeId: 'scope-api' } }),
        definition(scheduled, 'scope'),
      ),
    ).toBe('scope');
    expect(runCheckoutKind(run(), definition(scheduled))).toBe('scope');
  });
});

describe('prCheckoutProblem (slice 3, Call 15)', () => {
  const PR_CHECKOUT = '  checkout: { pr: item }\n';
  const REVIEW = '  on: { github: pull_request.review_requested }\n';

  it('says nothing of an entry that does not name the checkout', () => {
    expect(prCheckoutProblem(entry(REVIEW), { itemTypes: ['issue'] })).toBeNull();
    expect(prCheckoutProblem(entry(REVIEW), undefined)).toBeNull();
  });

  it('takes pr: item on a source whose items can be pull requests', () => {
    expect(prCheckoutProblem(entry(`${REVIEW}${PR_CHECKOUT}`), { itemTypes: ['pr'] })).toBeNull();
    expect(
      prCheckoutProblem(entry(`${REVIEW}${PR_CHECKOUT}`), { itemTypes: ['pr', 'issue'] }),
    ).toBeNull();
  });

  it('refuses it on a source whose items are never pull requests, or on no source at all', () => {
    // No connection's event gives issues alone yet (GitHub's events are pull requests'), so the source is hand-built.
    expect(prCheckoutProblem(entry(`${REVIEW}${PR_CHECKOUT}`), { itemTypes: ['issue'] })).toBe(
      '`pr: item` needs items that are pull requests.',
    );
    expect(prCheckoutProblem(entry(`${REVIEW}${PR_CHECKOUT}`), { itemTypes: [] })).toBe(
      PR_ITEM_NEEDS_PRS,
    );
    expect(prCheckoutProblem(entry(`${REVIEW}${PR_CHECKOUT}`), undefined)).toBe(PR_ITEM_NEEDS_PRS);
  });
});
