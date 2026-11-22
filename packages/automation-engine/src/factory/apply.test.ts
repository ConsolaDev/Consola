import { describe, expect, it, vi } from 'vitest';
import {
  automationVersion,
  factoryFilesOf,
  type AgentDefinition,
  parseFactory,
  stepsResolvedBody,
  type Automation,
  type FactoryFiles,
  type FactoryParseResult,
  type FactorySpecIssue,
} from '@consola/factory-spec';
import type { AgentHarnessAnswer } from '../ports';
import {
  agentIssues,
  agentQuery,
  appliedTexts,
  decideApply,
  describeAppliedAt,
  fileVersion,
  standingMessage,
} from './apply';

/** A folder's parse, from texts by path (and anything else the adapter would hand over). */
function read(
  texts: Record<string, string>,
  extra: Partial<FactoryFiles> = {},
): FactoryParseResult {
  return parseFactory({ ...factoryFilesOf(texts), ...extra });
}
const files = (texts: Record<string, string>, extra: Partial<FactoryFiles> = {}): FactoryFiles => ({
  ...factoryFilesOf(texts),
  ...extra,
});
const entry = (parse: FactoryParseResult, name: string): Automation => {
  const found = parse.automations.find((automation) => automation.name === name);
  if (!found) throw new Error(`No ${name} in ${JSON.stringify(parse.issues)}`);
  return found;
};

const REVIEWER = '---\nharness: claude-work\nmodel: opus\nmax_turns: 30\n---\nYou review.\n';
const TIDIER = '---\ndescription: Tidies.\n---\nYou tidy.\n';
const BROKEN_AGENT = '---\ntools: write\n---\nYou break.\n';
const CATALOG =
  'on: { cron: "0 7 * * 1-5" }\nscope: catalog-portal\nmode: auto\nsteps:\n  - id: look\n    agent: reviewer\n  - id: tell\n    prompt: Tell me what you saw.\n';
const NIGHTLY = `- name: nightly
    on: { cron: "0 9 * * *" }
    run: { prompt: "Summarise the night." }
    scope: api`;
const OLD_DIGEST = `- name: old-digest
    on: { cron: "0 8 * * *" }
    run: { prompt: "Digest." }
    scope: api`;
const factoryYml = (...entries: string[]) =>
  entries.length === 0
    ? 'version: 1\nautomations: []\n'
    : `version: 1\nautomations:\n${entries.map((text) => `  ${text}`).join('\n')}\n`;

/** The folder every decision row starts from: two entries in factory.yml, one in its own file, two agents. */
const BASE: Record<string, string> = {
  'factory.yml': factoryYml(NIGHTLY, OLD_DIGEST),
  'automations/catalog-review.yaml': CATALOG,
  'agents/reviewer.md': REVIEWER,
  'agents/tidier.md': TIDIER,
};
const clean = (texts: Record<string, string> = BASE) => ({ parse: read(texts), clean: true });
const none = (_automation: Automation): FactorySpecIssue[] => [];

describe('fileVersion', () => {
  it('is automationVersion for an entry without agents', () => {
    const parse = read(BASE);
    expect(fileVersion(entry(parse, 'nightly'), parse.agents)).toBe(
      automationVersion(entry(parse, 'nightly')),
    );
  });

  it("covers its agents' hashes, and no action body", () => {
    const parse = read(BASE);
    const catalog = entry(parse, 'catalog-review');
    expect(fileVersion(catalog, parse.agents)).toBe(
      automationVersion(catalog, stepsResolvedBody({}, { reviewer: parse.agents.reviewer.hash })),
    );
    expect(fileVersion(catalog, parse.agents)).not.toBe(automationVersion(catalog));
    // It takes no action bodies, so a settings edit never moves it.
    expect(fileVersion(catalog, parse.agents)).not.toBe(
      automationVersion(
        catalog,
        stepsResolvedBody({ look: 'Review it.' }, { reviewer: parse.agents.reviewer.hash }),
      ),
    );
  });

  it("moves when one of its agents' files does, and only then", () => {
    const before = read(BASE);
    const edited = read({ ...BASE, 'agents/reviewer.md': `${REVIEWER}Be brief.\n` });
    const tidied = read({ ...BASE, 'agents/tidier.md': `${TIDIER}Be brief.\n` });
    const version = (parse: FactoryParseResult) =>
      fileVersion(entry(parse, 'catalog-review'), parse.agents);
    expect(version(edited)).not.toBe(version(before));
    expect(version(tidied)).toBe(version(before));
  });
});

describe('agentQuery', () => {
  it("asks about the agent's harness, model, servers and skills", () => {
    const parse = read(BASE);
    expect(agentQuery(parse.agents.reviewer)).toEqual({
      harnessId: 'claude-work',
      model: 'opus',
      mcpServers: [],
      skills: [],
    });
    const bare = agentQuery(parse.agents.tidier);
    expect(bare).toEqual({ mcpServers: [], skills: [] });
    expect(Object.prototype.hasOwnProperty.call(bare, 'harnessId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'model')).toBe(false);
  });
});

describe('agentIssues', () => {
  const parse = read(BASE);
  const catalog = entry(parse, 'catalog-review');
  const answer = (fields: Partial<AgentHarnessAnswer>): AgentHarnessAnswer => ({
    name: 'Claude work',
    problem: null,
    stepProblem: null,
    agentProblem: null,
    warning: null,
    ...fields,
  });
  const at = { file: 'agents/reviewer.md', line: 2, path: 'harness', automation: 'catalog-review' };
  const TURNED_OFF =
    '`claude-work` is turned off: turn it on in Settings › Harnesses, or change `harness:`';

  it.each([
    [
      'its agentProblem',
      answer({ agentProblem: TURNED_OFF }),
      [{ ...at, message: `agents/reviewer.md: ${TURNED_OFF}` }],
    ],
    [
      'its read-only problem',
      answer({ problem: 'It has no read-only mode.' }),
      [
        {
          ...at,
          message: 'Claude work can’t run read-only automation sessions: It has no read-only mode',
        },
      ],
    ],
    [
      'its step problem',
      answer({ stepProblem: "This harness's extra arguments set `--model`." }),
      [
        {
          ...at,
          message:
            "Claude work can’t run automation steps: This harness's extra arguments set `--model`.",
        },
      ],
    ],
    [
      'the first of them',
      answer({ agentProblem: TURNED_OFF, problem: 'No.', stepProblem: 'No.' }),
      [{ ...at, message: `agents/reviewer.md: ${TURNED_OFF}` }],
    ],
    [
      'the read-only one before the step one',
      answer({ problem: 'No read-only', stepProblem: 'No steps' }),
      [{ ...at, message: 'Claude work can’t run read-only automation sessions: No read-only' }],
    ],
    ['nothing', answer({}), []],
  ])('a problem is %s, in the engine’s words', (_label, given, problems) => {
    expect(agentIssues(catalog, parse.agents, () => given)).toEqual({ problems, warnings: [] });
  });

  it("a warning is a notice at the agent's model line, and no problem", () => {
    const warning =
      '`opus-9` is not among the models Claude work lists; `--model` also takes a model’s full name.';
    expect(agentIssues(catalog, parse.agents, () => answer({ warning }))).toEqual({
      problems: [],
      warnings: [{ message: warning, file: 'agents/reviewer.md', line: 3 }],
    });
  });

  it('an agent with no harness: line is pointed at its first line, and one with no model: line has no line for a warning', () => {
    const tidy = read({
      ...BASE,
      'automations/tidy.yaml':
        'on: { cron: "0 7 * * 1-5" }\nscope: api\nsteps:\n  - id: tidy\n    agent: tidier\n',
    });
    expect(
      agentIssues(entry(tidy, 'tidy'), tidy.agents, () =>
        answer({ agentProblem: 'Not here', warning: 'Look.' }),
      ),
    ).toStrictEqual({
      problems: [
        {
          file: 'agents/tidier.md',
          line: 1,
          path: 'harness',
          automation: 'tidy',
          message: 'agents/tidier.md: Not here',
        },
      ],
      warnings: [{ message: 'Look.', file: 'agents/tidier.md' }],
    });
  });

  it('asks once per agent, and nothing for a step without one', () => {
    const twice = read({
      ...BASE,
      'automations/twice.yaml':
        'on: { cron: "0 7 * * 1-5" }\nscope: api\nsteps:\n  - id: a\n    agent: reviewer\n  - id: b\n    agent: tidier\n  - id: c\n    agent: reviewer\n  - id: d\n    prompt: Plain.\n',
    });
    const ask = vi.fn((_agent: AgentDefinition) => answer({}));
    agentIssues(entry(twice, 'twice'), twice.agents, ask);
    expect(ask.mock.calls.map(([agent]) => agent.name)).toEqual(['reviewer', 'tidier']);

    const plain = vi.fn((_agent: AgentDefinition) => answer({}));
    expect(agentIssues(entry(twice, 'nightly'), twice.agents, plain)).toEqual({
      problems: [],
      warnings: [],
    });
    expect(plain).not.toHaveBeenCalled();
  });
});

describe('decideApply', () => {
  const PROBLEM: FactorySpecIssue = {
    message: 'agents/reviewer.md: `claude-work` is turned off',
    file: 'agents/reviewer.md',
    path: 'harness',
    line: 2,
    automation: 'catalog-review',
  };
  /** The host has PROBLEM for catalog-review, and nothing for anything else. */
  const catalogProblem = (automation: Automation) =>
    automation.name === 'catalog-review' ? [PROBLEM] : [];
  const BROKEN = { 'agents/broken.md': BROKEN_AGENT };

  describe('the first clean apply (no clean applied version yet)', () => {
    it.each([
      ['no applied version, a clean read', null, BASE, none, 'applies'],
      [
        'no applied version, one bad entry',
        null,
        { ...BASE, 'automations/catalog-review.yaml': CATALOG.replace('mode: auto', 'mode: atuo') },
        none,
        'first-start',
      ],
      ['a clean: false version, a clean read', { clean: false }, BASE, none, 'applies'],
      [
        'a clean: false version, a host problem on one entry',
        { clean: false },
        BASE,
        catalogProblem,
        'first-start',
      ],
      ['no applied version, an empty read', null, {}, none, 'applies'],
      [
        'no applied version, a read issue in a file nobody uses',
        null,
        { ...BASE, ...BROKEN },
        none,
        'first-start',
      ],
    ] as const)('%s → %s', (_label, applied, texts, problemsOf, kind) => {
      const decision = decideApply({
        read: read(texts),
        applied: applied && { parse: read(BASE), clean: applied.clean },
        problemsOf,
      });
      expect(decision).toEqual({ kind });
    });

    it('asks the host about every entry, each counting as changed', () => {
      for (const applied of [null, { parse: read(BASE), clean: false }]) {
        const problemsOf = vi.fn(none);
        decideApply({ read: read(BASE), applied, problemsOf });
        expect(problemsOf.mock.calls.map(([automation]) => automation.name).sort()).toEqual([
          'catalog-review',
          'nightly',
          'old-digest',
        ]);
      }
    });
  });

  it('a clean applied version and a clean read, nothing from the host → applies', () => {
    expect(decideApply({ read: read(BASE), applied: clean(), problemsOf: none })).toEqual({
      kind: 'applies',
    });
  });

  it('a read issue anywhere, an agent file nobody uses included → keeps', () => {
    const decision = decideApply({
      read: read({ ...BASE, ...BROKEN }),
      applied: clean(),
      problemsOf: none,
    });
    expect(decision.kind).toBe('keeps');
    if (decision.kind !== 'keeps') return;
    expect(decision.removed).toEqual([]);
    expect(decision.blocking).toEqual(read({ ...BASE, ...BROKEN }).issues);
    expect(decision.blocking.map((issue) => issue.file)).toEqual(['agents/broken.md']);
  });

  it("a host problem blocks a changed entry, and is an unchanged one's own problem", () => {
    const edited = {
      ...BASE,
      'automations/catalog-review.yaml': CATALOG.replace('Tell me', 'Say'),
    };
    expect(
      decideApply({ read: read(edited), applied: clean(), problemsOf: catalogProblem }),
    ).toEqual({ kind: 'keeps', removed: [], blocking: [PROBLEM] });
    expect(decideApply({ read: read(BASE), applied: clean(), problemsOf: catalogProblem })).toEqual(
      {
        kind: 'applies',
      },
    );
  });

  it('an entry the applied version lacks is changed', () => {
    const added = {
      ...BASE,
      'automations/catalog-review.yaml': CATALOG,
      'automations/catalog-notes.yaml': CATALOG.replace('id: look', 'id: note'),
    };
    const problemsOf = (automation: Automation) =>
      automation.name === 'catalog-notes' ? [{ ...PROBLEM, automation: 'catalog-notes' }] : [];
    expect(decideApply({ read: read(added), applied: clean(), problemsOf }).kind).toBe('keeps');
  });

  it('an edit of an agent changes every entry that uses it, and no other', () => {
    const edited = { ...BASE, 'agents/reviewer.md': `${REVIEWER}Be brief.\n` };
    const asked = vi.fn(none);
    decideApply({ read: read(edited), applied: clean(), problemsOf: asked });
    expect(asked.mock.calls.map(([automation]) => automation.name)).toEqual(['catalog-review']);
  });

  it('a cron-only edit is no change: a host problem then applies', () => {
    const cron = { ...BASE, 'automations/catalog-review.yaml': CATALOG.replace('0 7', '0 6') };
    expect(decideApply({ read: read(cron), applied: clean(), problemsOf: catalogProblem })).toEqual(
      {
        kind: 'applies',
      },
    );
  });

  it('never asks the host about an unchanged entry', () => {
    const problemsOf = vi.fn(none);
    decideApply({ read: read({ ...BASE, ...BROKEN }), applied: clean(), problemsOf });
    expect(problemsOf).not.toHaveBeenCalled();
  });

  describe('removals, each beside an unrelated broken file', () => {
    /** The decision for `texts` (with the broken agent beside it) against the clean BASE. */
    const removedBy = (texts: Record<string, string | null>, extra: Partial<FactoryFiles> = {}) => {
      const next: Record<string, string> = { ...BROKEN };
      for (const [path, text] of Object.entries({ ...BASE, ...texts }))
        if (text !== null) next[path] = text;
      const decision = decideApply({
        read: parseFactory(files(next, extra)),
        applied: clean(),
        problemsOf: none,
      });
      if (decision.kind !== 'keeps') throw new Error(`Expected keeps, got ${decision.kind}`);
      return decision.removed;
    };

    it.each([
      [
        'an entry gone from a factory.yml that parses',
        { 'factory.yml': factoryYml(NIGHTLY) },
        ['old-digest'],
      ],
      [
        'gone because factory.yml does not parse',
        { 'factory.yml': 'version: 1\nautomations:\n  - name: nightly\n    on: [' },
        [],
      ],
      ['its own file deleted', { 'automations/catalog-review.yaml': null }, ['catalog-review']],
      ['its own file there but not YAML', { 'automations/catalog-review.yaml': 'on: [' }, []],
      [
        'its own file there with a problem of its own',
        { 'automations/catalog-review.yaml': CATALOG.replace('mode: auto', 'mode: atuo') },
        [],
      ],
      [
        'renamed in factory.yml',
        { 'factory.yml': factoryYml(NIGHTLY, OLD_DIGEST.replace('old-digest', 'new-digest')) },
        ['old-digest'],
      ],
      [
        'moved from factory.yml to its own file',
        {
          'factory.yml': factoryYml(NIGHTLY),
          'automations/old-digest.yaml':
            'on: { cron: "0 8 * * *" }\nrun: { prompt: "Digest." }\nscope: api\n',
        },
        [],
      ],
      ['factory.yml deleted', { 'factory.yml': null }, ['nightly', 'old-digest']],
      [
        'an entry defined twice',
        {
          'automations/old-digest.yaml':
            'on: { cron: "0 8 * * *" }\nrun: { prompt: "Digest." }\nscope: api\n',
        },
        [],
      ],
    ] as const)('%s → removed %j', (_label, texts, removed) => {
      expect(removedBy(texts)).toEqual(removed);
    });

    it('a file the adapter could not read is not gone, nor is a folder it could not list', () => {
      expect(
        removedBy(
          { 'automations/catalog-review.yaml': null },
          { unread: [{ path: 'automations/catalog-review.yaml', reason: 'EACCES' }] },
        ),
      ).toEqual([]);
      expect(
        removedBy(
          { 'automations/catalog-review.yaml': null },
          { unread: [{ path: 'automations/', reason: 'EACCES' }] },
        ),
      ).toEqual([]);
      expect(
        removedBy(
          { 'factory.yml': null },
          { unread: [{ path: 'factory.yml', reason: 'it is over 1 MB' }] },
        ),
      ).toEqual([]);
    });

    it('recomputed at each read, never carried', () => {
      expect(removedBy({ 'factory.yml': null })).toEqual(['nightly', 'old-digest']);
      expect(removedBy({})).toEqual([]);
    });
  });
});

describe('appliedTexts', () => {
  const texts = { ...BASE, 'agents/broken.md': BROKEN_AGENT };
  const parse = read(texts);

  it('without `only`, every text read', () => {
    expect(appliedTexts(files(texts), parse)).toEqual(texts);
  });

  it('with `only`, the texts those entries use', () => {
    expect(appliedTexts(files(texts), parse, [entry(parse, 'catalog-review')])).toEqual({
      'automations/catalog-review.yaml': CATALOG,
      'agents/reviewer.md': REVIEWER,
    });
    expect(
      appliedTexts(files(texts), parse, [entry(parse, 'nightly'), entry(parse, 'catalog-review')]),
    ).toEqual({
      'factory.yml': BASE['factory.yml'],
      'automations/catalog-review.yaml': CATALOG,
      'agents/reviewer.md': REVIEWER,
    });
    expect(appliedTexts(files(texts), parse, [])).toEqual({});
  });
});

describe('describeAppliedAt', () => {
  const at = new Date(2026, 10, 22, 10, 42).toISOString();

  it.each([
    ['the same day', at, new Date(2026, 10, 22, 18, 0), '10:42'],
    ['padded', new Date(2026, 10, 22, 9, 5).toISOString(), new Date(2026, 10, 22, 9, 6), '09:05'],
    ['another day', at, new Date(2026, 10, 23, 8, 0), '22 Nov 10:42'],
    [
      'another month',
      new Date(2026, 0, 3, 7, 0).toISOString(),
      new Date(2026, 1, 3, 7, 0),
      '3 Jan 07:00',
    ],
    ['another year, the same day and month', at, new Date(2027, 10, 22, 11, 0), '22 Nov 10:42'],
  ])('%s', (_label, appliedAt, now, words) => {
    expect(describeAppliedAt(appliedAt, now)).toBe(words);
  });
});

describe('standingMessage', () => {
  const AT = new Date(2026, 10, 22, 10, 42).toISOString();
  const NOW = new Date(2026, 10, 22, 12, 0);
  const issue = (file: string): FactorySpecIssue => ({ message: 'No.', path: '', file });
  const keeps = (blocking: FactorySpecIssue[], removed: string[] = []) => ({
    kind: 'keeps' as const,
    removed,
    blocking,
  });

  it.each([
    [
      [issue('agents/investigator.md')],
      [],
      "Your changes didn't apply: 1 problem in agents/investigator.md. The version from 10:42 keeps running.",
    ],
    [
      [
        issue('agents/investigator.md'),
        issue('automations/x.yaml'),
        issue('agents/investigator.md'),
      ],
      [],
      "Your changes didn't apply: 3 problems in agents/investigator.md and automations/x.yaml. The version from 10:42 keeps running.",
    ],
    [
      [issue('a'), issue('b'), issue('c')],
      [],
      "Your changes didn't apply: 3 problems in a, b and c. The version from 10:42 keeps running.",
    ],
    [
      [issue('a'), issue('b'), issue('c'), issue('d')],
      [],
      "Your changes didn't apply: 4 problems in a, b, c and 1 more file. The version from 10:42 keeps running.",
    ],
    [
      [issue('a'), issue('b'), issue('c'), issue('d'), issue('e')],
      [],
      "Your changes didn't apply: 5 problems in a, b, c and 2 more files. The version from 10:42 keeps running.",
    ],
    [
      [issue('agents/investigator.md')],
      ['old-digest'],
      "`old-digest` was removed. The rest of your changes didn't apply: 1 problem in agents/investigator.md. The version from 10:42 keeps running.",
    ],
    [
      [issue('agents/investigator.md')],
      ['a', 'b'],
      "`a` and `b` were removed. The rest of your changes didn't apply: 1 problem in agents/investigator.md. The version from 10:42 keeps running.",
    ],
    [
      [issue('agents/investigator.md')],
      ['a', 'b', 'c'],
      "`a`, `b` and `c` were removed. The rest of your changes didn't apply: 1 problem in agents/investigator.md. The version from 10:42 keeps running.",
    ],
  ])('%j removing %j', (blocking, removed, message) => {
    expect(standingMessage(keeps(blocking, removed), AT, NOW)).toBe(message);
  });

  it('counts and names only the files that have the problems, never one a problem shows through (review M1)', () => {
    const derived = (file: string, cause: string): FactorySpecIssue => ({ ...issue(file), cause });
    expect(
      standingMessage(
        keeps([
          issue('agents/reviewer.md'),
          derived('automations/catalog-review.yaml', 'agents/reviewer.md'),
          derived('factory.yml', 'agents/reviewer.md'),
        ]),
        AT,
        NOW,
      ),
    ).toBe(
      "Your changes didn't apply: 1 problem in agents/reviewer.md. The version from 10:42 keeps running.",
    );
    // One broken skill is one problem in its folder, not three in three files.
    expect(
      standingMessage(
        keeps([
          issue('skills/triage/SKILL.md'),
          derived('agents/investigator.md', 'skills/triage/'),
          derived('automations/x.yaml', 'agents/investigator.md'),
        ]),
        AT,
        NOW,
      ),
    ).toBe(
      "Your changes didn't apply: 1 problem in skills/triage/SKILL.md. The version from 10:42 keeps running.",
    );
  });

  it('never says "0 problems": with only problems that show another through, it counts them', () => {
    const derived = { ...issue('automations/x.yaml'), cause: 'agents/gone.md' };
    expect(standingMessage(keeps([derived]), AT, NOW)).toBe(
      "Your changes didn't apply: 1 problem in automations/x.yaml. The version from 10:42 keeps running.",
    );
  });

  it('words the time against `now`', () => {
    expect(standingMessage(keeps([issue('a')]), AT, new Date(2026, 10, 23, 9, 0))).toBe(
      "Your changes didn't apply: 1 problem in a. The version from 22 Nov 10:42 keeps running.",
    );
  });
});
