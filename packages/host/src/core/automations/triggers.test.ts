// @effect-diagnostics nodeBuiltinImport:off - The tests read factory-spec's fixture.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactoryFile, FactorySnapshot, PullRequestFacts } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import { admissionOf } from './approval.ts';
import { eventNameOf, matchEvent } from './triggers.ts';

const FIXTURE = fileURLToPath(
  new URL('../../../../factory-spec/src/fixtures/review-pull-requests', import.meta.url),
);

function filesIn(folder: string, prefix = ''): FactoryFile[] {
  return readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesIn(folder, path)
      : [{ path, content: readFileSync(join(folder, path), 'utf8') }];
  });
}

const REVIEW_FILES = filesIn(FIXTURE);
const AGENTS = REVIEW_FILES.filter((file) => file.path.startsWith('agents/'));

const factory = (files: FactoryFile[], factoryId = 'factory-sprocket'): FactorySnapshot => ({
  factoryId,
  version: 1,
  files,
});

/** A factory of `automation`, the reviewer beside it. */
const withEntry = (automation: string, factoryId?: string) =>
  factory(
    [
      { path: 'factory.yml', content: 'version: 1\nrepos: [sprocket/catalog-portal]\n' },
      { path: 'automations/entry.yaml', content: automation },
      ...AGENTS,
    ],
    factoryId,
  );

const STEPS = `steps:
  - id: review
    agent: reviewer
    prompt: Review it.
`;

const pullRequest = (fields: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  name: 'pull_request',
  action: 'opened',
  repository: 'sprocket/catalog-portal',
  number: 42,
  url: 'https://github.com/sprocket/catalog-portal/pull/42',
  title: 'Add a retry to the catalog sync',
  author: 'JaviDev',
  draft: false,
  headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  headRef: 'fix/catalog-retry',
  baseRef: 'main',
  fork: false,
  ...fields,
});

describe('matchEvent', () => {
  it('names an event as an entry lists it', () => {
    expect(eventNameOf(pullRequest({ action: 'synchronize' }))).toBe('pull_request.synchronize');
  });

  it('matches the Review pull requests entry on each event it lists, and nothing else', () => {
    for (const action of ['opened', 'synchronize', 'reopened']) {
      const { matches, notes } = matchEvent([factory(REVIEW_FILES)], pullRequest({ action }));
      expect(matches.map((match) => [match.automation.name, match.event])).toEqual([
        ['review-pr', `pull_request.${action}`],
      ]);
      expect(matches[0]?.factory).toEqual({ id: 'factory-sprocket', version: 1 });
      expect(matches[0]?.source.connection).toBe('github');
      expect(notes).toEqual([]);
    }
    const closed = matchEvent([factory(REVIEW_FILES)], pullRequest({ action: 'closed' }));
    expect(closed).toEqual({ matches: [], notes: [] });
  });

  it('holds a pull request to the entry’s filter, by the engine’s rules: a draft never fires unasked', () => {
    expect(matchEvent([factory(REVIEW_FILES)], pullRequest({ draft: true })).matches).toEqual([]);
    const filtered = withEntry(
      `on: { github: { events: [pull_request.opened], filter: { repos: ['sprocket/*'], authors_not: ['dependabot[bot]'], drafts: true } } }\n${STEPS}`,
    );
    expect(matchEvent([filtered], pullRequest({ draft: true })).matches).toHaveLength(1);
    expect(matchEvent([filtered], pullRequest({ repository: 'acme/api' })).matches).toEqual([]);
    expect(matchEvent([filtered], pullRequest({ author: 'dependabot[bot]' })).matches).toEqual([]);
  });

  it('matches every factory’s entries, each factory on its own', () => {
    const { matches } = matchEvent(
      [factory(REVIEW_FILES), factory(REVIEW_FILES, 'factory-acme')],
      pullRequest(),
    );
    expect(matches.map((match) => match.factory.id)).toEqual(['factory-sprocket', 'factory-acme']);
  });

  it('runs nothing of a factory with problems, and says so in a note', () => {
    const broken = factory([
      ...REVIEW_FILES,
      {
        path: 'automations/broken.yaml',
        content: 'on: { github: { events: [pull_request.opened] } }\n',
      },
    ]);
    const { matches, notes } = matchEvent([broken], pullRequest());
    expect(matches).toEqual([]);
    expect(notes).toEqual([
      'factory factory-sprocket v1 has 1 problem in its files, so none of its automations runs for pull_request.opened',
    ]);
  });

  it('refuses, in a note and never loosely, an entry it cannot honour exactly', () => {
    const inbox = withEntry(
      `on: { github: { events: [pull_request.opened, pull_request.review_requested] } }\n${STEPS}`,
    );
    const legacy = withEntry(
      'on: { github: { events: [pull_request.opened] } }\nrun: { prompt: Review it. }\n',
    );
    const owned = withEntry(
      `on: { github: { events: [pull_request.opened] } }\ncheckout: { repo: sprocket/catalog-portal, branch: consola/fix }\n${STEPS}`,
    );
    for (const snapshot of [inbox, legacy, owned]) {
      const { matches, notes } = matchEvent([snapshot], pullRequest());
      expect(matches).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(
        /^factory factory-sprocket v1: entry does not run for pull_request\.opened: /,
      );
    }
    expect(matchEvent([inbox], pullRequest()).notes[0]).toContain(
      '`pull_request.review_requested` is not an event a cloud runner fires',
    );
    expect(matchEvent([legacy], pullRequest()).notes[0]).toContain('it is a `run:` entry');
  });

  it('ignores entries that do not name the event, whatever is wrong with them', () => {
    const schedule = withEntry(`on: { cron: "0 9 * * 1" }\nscope: catalog-portal\n${STEPS}`);
    const other = withEntry(
      `on: { github: { events: [pull_request.review_requested] } }\n${STEPS}`,
    );
    expect(matchEvent([schedule, other], pullRequest())).toEqual({ matches: [], notes: [] });
  });
});

describe('admissionOf', () => {
  it('asks a person for every run in stage 1, an entry in `mode: auto` included', () => {
    const [match] = matchEvent([factory(REVIEW_FILES)], pullRequest()).matches;
    if (match === undefined) throw new Error('no match');
    expect(match.automation.mode).toBe('auto');
    expect(admissionOf(match.automation)).toBe('ask');
  });
});
