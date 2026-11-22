import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';

/*
 * An entry's checkout the run owns (slice 3-B), against what the entry's
 * items are: a branch that names an item needs one, `{{item.number}}` needs
 * items with numbers, and the checkout says where the run works, so no
 * `scope:`, and none is needed.
 */

/** The messages of one steps entry with `on`, a run-owned checkout on `branch`, and `extra` lines. */
const entryMessages = (on: string, branch: string, extra = '') =>
  parseFactorySpec(
    `version: 1\nautomations:\n  - name: fix\n    ${on}\n    checkout: { repo: sprocket/catalog-portal, branch: "${branch}" }\n${extra ? `    ${extra}\n` : ''}    steps:\n      - prompt: hi\n`,
  ).issues.map((issue) => issue.message);

const NO_ITEM =
  'This automation has no item; its branch takes `{{run.id}}`, e.g. `consola/run-{{run.id}}`.';
const NO_NUMBER = "A poll's items have no number; use `{{item.key}}`.";

describe('a run-owned checkout on an entry', () => {
  it.each([
    ['on: { cron: "0 9 * * *" }', 'fix/{{item.key}}', NO_ITEM],
    ['on: { poll: { every: 10m, run: "echo []", key: .key } }', 'fix/{{item.number}}', NO_NUMBER],
    // Beyond the plan's rows: a run on demand with no item, and `{{item.number}}` on one.
    ['on: manual', 'fix/{{item.key}}', NO_ITEM],
    ['on: manual', 'ui/pr-{{item.number}}', NO_ITEM],
  ])('branch placeholders against the items: %s', (on, branch, words) =>
    expect(entryMessages(on, branch)).toContainEqual(expect.stringContaining(words)),
  );

  it.each([
    ['an event', 'on: { github: pull_request.review_requested }', 'ui/pr-{{item.number}}'],
    ['a keyed poll', 'on: { poll: { every: 10m, run: "echo []", key: .key } }', 'fix/{{item.key}}'],
    ['a run on demand on items', 'on: manual\n    applies_to: [pr]', 'fix/{{item.number}}'],
    [
      'a poll with item:',
      'on: { poll: { every: 5m, run: "echo []", item: { github: .url } } }',
      'fix/{{item.number}}-{{run.id}}',
    ],
  ])('takes what its items have: %s', (_, on, branch) =>
    expect(entryMessages(on, branch)).toEqual([]),
  );

  it('a run-owned checkout says where it runs: no scope:, and none needed', () => {
    expect(entryMessages('on: { cron: "0 9 * * *" }', 'consola/run-{{run.id}}')).toEqual([]);
    expect(
      entryMessages('on: { cron: "0 9 * * *" }', 'consola/run-{{run.id}}', 'scope: app'),
    ).toContain('The checkout says where this runs; remove `scope:`.');
  });

  it('points a placeholder problem at the branch', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: fix\n    on: { cron: "0 9 * * *" }\n    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.key}}" }\n    steps:\n      - prompt: hi\n',
    );
    expect(result.issues).toEqual([
      { message: NO_ITEM, path: 'automations[0].checkout.branch', line: 5, automation: 'fix' },
    ]);
  });

  it('goes with steps:, as 3-A said of { pr: item }', () =>
    expect(
      parseFactorySpec(
        'version: 1\nautomations:\n  - name: fix\n    on: { cron: "0 9 * * *" }\n    scope: app\n    checkout: { repo: sprocket/catalog-portal, branch: "consola/run-{{run.id}}" }\n    run: { prompt: hi }\n',
      ).issues.map((issue) => issue.message),
    ).toContain('`checkout` goes with `steps:`.'));
});
