import { describe, expect, it } from 'vitest';
import { parseFactorySpec, type RunItem, type StepsAutomation } from '@consola/factory-spec';
import type { RunDefinition } from '../steps/definition';
import { runItemSource } from './itemSource';

const STEPS = '    steps:\n      - id: look\n        prompt: Look.\n';

function definition(fields: string): RunDefinition {
  const parsed = parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}${STEPS}`);
  if (parsed.issues.length > 0)
    throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
  return { automation: parsed.automations[0] as StepsAutomation, version: 'v', actions: {} };
}

const parses = { canParseUrls: (connection: string) => connection === 'github' };
const parsesNothing = { canParseUrls: () => false };

const pr: RunItem = {
  key: 'github:sprocket/catalog-portal:pr:51',
  url: 'https://github.com/sprocket/catalog-portal/pull/51',
  title: 'Add retries',
  repo: 'sprocket/catalog-portal',
  number: 51,
  type: 'pr',
  author: 'alice',
};
const GITHUB_HEADER =
  'pull request #51 in sprocket/catalog-portal (https://github.com/sprocket/catalog-portal/pull/51)';

describe('runItemSource', () => {
  it("gives an event definition its connection's source", () => {
    const source = runItemSource(
      definition('    on: { github: { events: [pull_request.review_requested] } }\n'),
      parsesNothing,
    );
    expect(source).toMatchObject({
      connection: 'github',
      itemTypes: ['pr'],
      itemsHaveRepo: true,
      describe: 'When a pull request asks for your review',
    });
    expect(source?.itemFields?.number).toEqual({ type: { kind: 'number' }, trusted: true });
    expect(source?.describeItemHeader(pr)).toBe(GITHUB_HEADER);
  });

  it('gives a poll definition a poll source, with the work-item part when its connection can read URLs', () => {
    const poll =
      '    on: { poll: { every: 30m, run: gh api graphql, item: { github: .url }, changed: .head } }\n';
    const withPart = runItemSource(definition(poll), parses);
    expect(withPart).toMatchObject({
      connection: 'github',
      itemTypes: ['pr', 'issue'],
      itemsHaveRepo: true,
      describe: 'Every 30 minutes, checks with a command',
      goneReason: 'It is no longer in what its check returns.',
    });
    expect(withPart?.itemFields).toBeUndefined();
    expect(withPart?.describeItemHeader(pr)).toBe(GITHUB_HEADER);
    expect(withPart?.itemValue(pr, 'number', { number: 99, head: 'abc' })).toBe(51);
    expect(withPart?.itemValue(pr, 'head', { number: 99, head: 'abc' })).toBe('abc');

    // A connection that cannot read URLs gives no work-item part: nothing names the item by it.
    const withoutPart = runItemSource(definition(poll), parsesNothing);
    expect(withoutPart?.describe).toBe('Every 30 minutes, checks with a command');
    expect(withoutPart?.itemsHaveRepo).toBe(false);
    expect(withoutPart?.describeItemHeader(pr)).toBe('the item described below');

    const keyed = runItemSource(
      definition('    on: { poll: { every: 1h, run: ./tickets, key: .id } }\n    scope: api\n'),
      parses,
    );
    expect(keyed).toMatchObject({
      itemTypes: [],
      itemsHaveRepo: false,
      describe: 'Every 1 hour, checks with a command',
    });
    expect(keyed?.connection).toBeUndefined();
    expect(keyed?.describeItemHeader({ key: '7', url: '', title: 'Ticket 7' })).toBe(
      'the item described below',
    );
  });

  it('gives a manual definition with applies_to the work-item source', () => {
    const source = runItemSource(
      definition('    on: manual\n    applies_to: [pr]\n'),
      parsesNothing,
    );
    expect(source).toMatchObject({ connection: 'github', itemTypes: ['pr'], itemsHaveRepo: true });
    expect(source?.itemFields?.title).toEqual({ type: { kind: 'string' }, trusted: false });
    expect(source?.describeItemHeader(pr)).toBe(GITHUB_HEADER);
    expect(source?.itemValue(pr, 'repo')).toBe('sprocket/catalog-portal');
    expect(source?.fenceItem(pr)).toContain(
      '<untrusted-data>\ntitle: "Add retries"\nauthor: "alice"\n</untrusted-data>',
    );
    expect(
      runItemSource(definition('    on: manual\n    applies_to: [pr, issue]\n'), parsesNothing)
        ?.itemTypes,
    ).toEqual(['pr', 'issue']);
  });

  it('gives a cron definition, and a manual one with no item, nothing', () => {
    expect(
      runItemSource(definition('    on: { cron: "0 9 * * 1-5" }\n    scope: api\n'), parses),
    ).toBeUndefined();
    expect(runItemSource(definition('    on: manual\n    scope: api\n'), parses)).toBeUndefined();
  });
});
