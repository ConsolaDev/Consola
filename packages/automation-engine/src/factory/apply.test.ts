import { describe, expect, it, vi } from 'vitest';
import {
  automationVersion,
  factoryFilesOf,
  parseFactory,
  stepsResolvedBody,
} from '@consola/factory-spec';
import type {
  AgentDefinition,
  Automation,
  FactoryFiles,
  FactoryParseResult,
  FactorySpecIssue,
} from '@consola/factory-spec';
import type { AgentHarnessAnswer, CheckoutKind } from '../ports';
import {
  agentIssues,
  agentQuery,
  appliedSkills,
  entryEnvironmentHashes,
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
    expect(agentQuery(parse.agents.reviewer, 'scope')).toEqual({
      harnessId: 'claude-work',
      model: 'opus',
      mcpServers: [],
      skills: [],
      checkout: 'scope',
    });
    const bare = agentQuery(parse.agents.tidier, 'scope');
    expect(bare).toEqual({ mcpServers: [], skills: [], checkout: 'scope' });
    expect(Object.prototype.hasOwnProperty.call(bare, 'harnessId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bare, 'model')).toBe(false);
  });

  it('asks for the checkout kind it is given (2-C)', () => {
    expect(agentQuery(read(BASE).agents.reviewer, 'item').checkout).toBe('item');
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
    expect(agentIssues(catalog, parse.agents, () => given)).toEqual({
      problems,
      waits: [],
      stops: [],
      warnings: [],
    });
  });

  it("a warning is a notice at the agent's model line, and no problem", () => {
    const warning =
      '`opus-9` is not among the models Claude work lists; `--model` also takes a model’s full name.';
    expect(agentIssues(catalog, parse.agents, () => answer({ warning }))).toEqual({
      problems: [],
      waits: [],
      stops: [],
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
      waits: [],
      stops: [],
      warnings: [{ message: 'Look.', file: 'agents/tidier.md' }],
    });
  });

  it('asks once per agent, and nothing for a step without one', () => {
    const twice = read({
      ...BASE,
      'automations/twice.yaml':
        'on: { cron: "0 7 * * 1-5" }\nscope: api\nsteps:\n  - id: a\n    agent: reviewer\n  - id: b\n    agent: tidier\n  - id: c\n    agent: reviewer\n  - id: d\n    prompt: Plain.\n',
    });
    const ask = vi.fn((_agent: AgentDefinition, _checkout: CheckoutKind) => answer({}));
    agentIssues(entry(twice, 'twice'), twice.agents, ask);
    expect(ask.mock.calls.map(([agent]) => agent.name)).toEqual(['reviewer', 'tidier']);

    const plain = vi.fn((_agent: AgentDefinition, _checkout: CheckoutKind) => answer({}));
    expect(agentIssues(entry(twice, 'nightly'), twice.agents, plain)).toEqual({
      problems: [],
      waits: [],
      stops: [],
      warnings: [],
    });
    expect(plain).not.toHaveBeenCalled();
  });

  it("asks about an agent that only a loop's step names", () => {
    const looped = read({
      ...BASE,
      'automations/looped.yaml':
        'on: { cron: "0 7 * * 1-5" }\nscope: api\nsteps:\n  - id: plain\n    prompt: Plain.\n  - id: polish\n    repeat: { max: 2, until: steps.a.ok }\n    steps:\n      - id: a\n        agent: tidier\n        outputs: { ok: boolean }\n',
    });
    expect(looped.issues).toEqual([]);
    const ask = vi.fn((_agent: AgentDefinition, _checkout: CheckoutKind) => answer({}));
    agentIssues(entry(looped, 'looped'), looped.agents, ask);
    expect(ask.mock.calls.map(([agent]) => agent.name)).toEqual(['tidier']);
  });

  describe('servers (2-C)', () => {
    const INVESTIGATOR =
      '---\nharness: stub-work\nmodel: opus\nmcpServers: [grafana]\n---\nYou investigate.\n';
    const servers = read({
      ...BASE,
      'agents/investigator.md': INVESTIGATOR,
      'automations/investigate.yaml':
        'on: { cron: "0 7 * * 1-5" }\nscope: api\nsteps:\n  - id: look\n    agent: investigator\n',
      'automations/on-review.yaml':
        'on: { github: pull_request.review_requested }\nsteps:\n  - id: look\n    agent: investigator\n',
    });
    const investigate = entry(servers, 'investigate');
    const at = (path: string, line: number) => ({
      file: 'agents/investigator.md',
      line,
      path,
      automation: 'investigate',
    });
    const issuesOf = (given: Partial<AgentHarnessAnswer>) =>
      agentIssues(investigate, servers.agents, () => answer({ name: 'Work stub', ...given }));

    it("asks with the entry's checkout kind: item for an event entry, scope for a schedule", () => {
      const ask = vi.fn((_agent: AgentDefinition, _checkout: CheckoutKind) => answer({}));
      agentIssues(entry(servers, 'on-review'), servers.agents, ask);
      agentIssues(investigate, servers.agents, ask);
      expect(ask.mock.calls.map(([, checkout]) => checkout)).toEqual(['item', 'scope']);
    });

    it('a probe under way is a wait, at the mcpServers: line, and no problem', () => {
      expect(issuesOf({ serversPending: 'Asking Work stub which MCP servers it has.' })).toEqual({
        problems: [],
        waits: [
          {
            ...at('mcpServers', 4),
            message: 'agents/investigator.md: Asking Work stub which MCP servers it has.',
          },
        ],
        stops: [],
        warnings: [],
      });
    });

    it('a probe that failed is a stop, and no problem', () => {
      expect(
        issuesOf({ serversUnknown: "Couldn't ask Work stub which MCP servers it has: no." }),
      ).toEqual({
        problems: [],
        waits: [],
        stops: [
          {
            ...at('mcpServers', 4),
            message: "agents/investigator.md: Couldn't ask Work stub which MCP servers it has: no.",
          },
        ],
        warnings: [],
      });
    });

    it("a server refused is a problem at the mcpServers: line; the harness's own stay at harness:", () => {
      const refused = "`grafana` isn't one of Work stub's MCP servers (it has none).";
      expect(issuesOf({ serversProblem: refused }).problems).toEqual([
        { ...at('mcpServers', 4), message: `agents/investigator.md: ${refused}` },
      ]);
      expect(issuesOf({ stepProblem: 'It sets `--model`.' }).problems).toEqual([
        {
          ...at('harness', 2),
          message: 'Work stub can’t run automation steps: It sets `--model`.',
        },
      ]);
    });

    it('the first of agentProblem and serversProblem; a problem leaves no wait and no stop', () => {
      expect(issuesOf({ agentProblem: 'Off.', serversProblem: 'Unknown.' }).problems).toEqual([
        { ...at('harness', 2), message: 'agents/investigator.md: Off.' },
      ]);
      expect(issuesOf({ serversProblem: 'Unknown.', problem: 'No read-only.' }).problems).toEqual([
        { ...at('mcpServers', 4), message: 'agents/investigator.md: Unknown.' },
      ]);
      expect(issuesOf({ agentProblem: 'Off.', serversPending: 'Asking.' })).toMatchObject({
        problems: [{ message: 'agents/investigator.md: Off.' }],
        waits: [],
        stops: [],
      });
      expect(issuesOf({ serversProblem: 'Unknown.', serversUnknown: 'Failed.' })).toMatchObject({
        problems: [{ message: 'agents/investigator.md: Unknown.' }],
        waits: [],
        stops: [],
      });
    });

    it("server warnings follow the model's, at the mcpServers: line, and stop nothing", () => {
      expect(
        issuesOf({ warning: 'A model.', serverWarnings: ['a', 'b'], serversPending: null }),
      ).toEqual({
        problems: [],
        waits: [],
        stops: [],
        warnings: [
          { message: 'A model.', file: 'agents/investigator.md', line: 3 },
          { message: 'a', file: 'agents/investigator.md', line: 4 },
          { message: 'b', file: 'agents/investigator.md', line: 4 },
        ],
      });
    });

    it('an agent naming no server is pointed at its first line for a wait', () => {
      expect(
        agentIssues(entry(servers, 'catalog-review'), servers.agents, () =>
          answer({ serversUnknown: 'Failed.' }),
        ).stops,
      ).toEqual([
        {
          file: 'agents/reviewer.md',
          line: 1,
          path: 'mcpServers',
          automation: 'catalog-review',
          message: 'agents/reviewer.md: Failed.',
        },
      ]);
    });
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

  describe('waits (2-C)', () => {
    const WAIT: FactorySpecIssue = {
      message: 'agents/reviewer.md: Asking Claude work which MCP servers it has.',
      file: 'agents/reviewer.md',
      path: 'mcpServers',
      line: 1,
      automation: 'catalog-review',
    };
    const catalogWaits = (automation: Automation) =>
      automation.name === 'catalog-review' ? [WAIT] : [];
    const edited = {
      ...BASE,
      'automations/catalog-review.yaml': CATALOG.replace('Tell me', 'Say'),
    };

    it('a changed entry that only waits keeps the applied version, waiting and not blocking', () => {
      expect(
        decideApply({
          read: read(edited),
          applied: clean(),
          problemsOf: none,
          waitsOf: catalogWaits,
        }),
      ).toEqual({ kind: 'keeps', removed: [], blocking: [], waiting: [WAIT] });
    });

    it('a problem and no wait has no waiting key', () => {
      const decision = decideApply({
        read: read(edited),
        applied: clean(),
        problemsOf: catalogProblem,
        waitsOf: none,
      });
      expect(decision).toEqual({ kind: 'keeps', removed: [], blocking: [PROBLEM] });
      expect(Object.prototype.hasOwnProperty.call(decision, 'waiting')).toBe(false);
    });

    it('nothing changed and a wait applies: an unchanged entry is never asked', () => {
      const waitsOf = vi.fn(catalogWaits);
      expect(
        decideApply({ read: read(BASE), applied: clean(), problemsOf: none, waitsOf }),
      ).toEqual({ kind: 'applies' });
      expect(waitsOf).not.toHaveBeenCalled();
    });

    it('a first start counts a wait as it counts a problem', () => {
      expect(
        decideApply({ read: read(BASE), applied: null, problemsOf: none, waitsOf: catalogWaits }),
      ).toEqual({ kind: 'first-start' });
    });
  });

  describe('removals, each beside an unrelated broken file', () => {
    /** The decision for `texts` (with the broken agent beside it) against the clean BASE. */
    const removedBy = (texts: Record<string, string | null>, extra: Partial<FactoryFiles> = {}) => {
      const next: Record<string, string> = { ...BROKEN };
      for (const [path, text] of Object.entries({ ...BASE, ...texts })) {
        if (text !== null) next[path] = text;
      }
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

  it('keeps environments/<n>.yaml, read back by factoryFilesOf (slice 3-B)', () => {
    const withEnvironment = { ...texts, 'environments/sandboxed.yaml': 'isolation: sandbox\n' };
    const kept = appliedTexts(files(withEnvironment), read(withEnvironment));
    expect(kept).toEqual(withEnvironment);
    expect(factoryFilesOf(kept).environments).toEqual({ sandboxed: 'isolation: sandbox\n' });
  });
});

describe('write agents and their environments (slice 3-B)', () => {
  const FIXER = '---\nharness: claude-work\ntools: write\nenvironment: sandboxed\n---\nFix it.\n';
  const SANDBOXED = 'isolation: sandbox\nnetwork: [registry.npmjs.org]\n';
  const FIX =
    'version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n  - name: fix\n    on: manual\n    checkout: { repo: sprocket/catalog-portal, branch: "consola/run-{{run.id}}" }\n    steps:\n      - id: fix\n        agent: fixer\n        prompt: Fix it.\n';
  const WRITING: Record<string, string> = {
    'factory.yml': FIX,
    'agents/fixer.md': FIXER,
    'environments/sandboxed.yaml': SANDBOXED,
    'environments/other.yaml': 'isolation: host\n',
    'agents/reviewer.md': REVIEWER,
    'automations/catalog-review.yaml': CATALOG,
  };
  const versionOf = (texts: Record<string, string>, name = 'fix') => {
    const parse = read(texts);
    expect(parse.issues).toEqual([]);
    return fileVersion(entry(parse, name), parse.agents, parse.environments);
  };

  it('covers the environment its agent names, as the resolved version does', () => {
    const parse = read(WRITING);
    const fix = entry(parse, 'fix');
    expect(fileVersion(fix, parse.agents, parse.environments)).toBe(
      automationVersion(
        fix,
        stepsResolvedBody(
          {},
          { fixer: parse.agents.fixer.hash },
          { sandboxed: parse.environments.sandboxed.hash },
        ),
      ),
    );
    expect(entryEnvironmentHashes(fix, parse.agents, parse.environments)).toEqual({
      sandboxed: parse.environments.sandboxed.hash,
    });
  });

  it('moves when that environment changes by one byte, and not for another one', () => {
    const before = versionOf(WRITING);
    expect(
      versionOf({ ...WRITING, 'environments/sandboxed.yaml': SANDBOXED.replace('npmjs', 'npmjz') }),
    ).not.toBe(before);
    expect(versionOf({ ...WRITING, 'environments/other.yaml': 'isolation: sandbox\n' })).toBe(
      before,
    );
    // An entry whose agents name no environment is as it was.
    const catalog = entry(read(WRITING), 'catalog-review');
    expect(fileVersion(catalog, read(WRITING).agents, read(WRITING).environments)).toBe(
      fileVersion(catalog, read(WRITING).agents),
    );
  });

  it('so an environment edit is a changed entry the read asks about', () => {
    const problemsOf = vi.fn(none);
    decideApply({
      read: read({ ...WRITING, 'environments/sandboxed.yaml': 'isolation: sandbox\n' }),
      applied: { parse: read(WRITING), clean: true },
      problemsOf,
    });
    expect(problemsOf.mock.calls.map(([automation]) => automation.name)).toEqual(['fix']);
    const unchanged = vi.fn(none);
    decideApply({
      read: read(WRITING),
      applied: { parse: read(WRITING), clean: true },
      problemsOf: unchanged,
    });
    expect(unchanged).not.toHaveBeenCalled();
  });

  it('a first start keeps the environment file of every agent its entries name, and no other', () => {
    const parse = read(WRITING);
    expect(appliedTexts(files(WRITING), parse, [entry(parse, 'fix')])).toEqual({
      'factory.yml': FIX,
      'agents/fixer.md': FIXER,
      'environments/sandboxed.yaml': SANDBOXED,
    });
  });

  it("asks the host about a write agent's tools and environment; a read-only agent's query is as before", () => {
    const parse = read(WRITING);
    expect(agentQuery(parse.agents.fixer, 'scope', parse.environments)).toEqual({
      harnessId: 'claude-work',
      mcpServers: [],
      skills: [],
      checkout: 'scope',
      tools: 'write',
      environment: {
        name: 'sandboxed',
        isolation: 'sandbox',
        network: ['registry.npmjs.org'],
        env: [],
      },
    });
    expect(agentQuery(parse.agents.reviewer, 'scope', parse.environments)).toEqual(
      agentQuery(parse.agents.reviewer, 'scope'),
    );
  });
});

describe('appliedSkills (2-C)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const skill = (name: string, extra: Array<{ path: string; bytes: Uint8Array }> = []) => [
    {
      path: 'SKILL.md',
      bytes: bytes(`---\nname: ${name}\ndescription: The ${name} notes.\n---\nRead me.\n`),
    },
    ...extra,
  ];
  const TRIAGE = skill('incident-triage', [
    { path: 'queries.md', bytes: bytes('rate() over 5m.\n') },
  ]);
  const NOTES = skill('release-notes');
  const TRIAGER = '---\nharness: claude-work\nskills: [incident-triage]\n---\nYou triage.\n';
  const WRITER =
    '---\nharness: claude-work\nskills: [release-notes, incident-triage]\n---\nYou write.\n';
  const TRIAGE_ENTRY =
    'on: { cron: "0 7 * * 1-5" }\nscope: catalog-portal\nmode: auto\nsteps:\n  - id: look\n    agent: triager\n';
  const texts = {
    'factory.yml': factoryYml(NIGHTLY),
    'automations/triage.yaml': TRIAGE_ENTRY,
    'automations/write.yaml': TRIAGE_ENTRY.replace('agent: triager', 'agent: writer'),
    'agents/triager.md': TRIAGER,
    'agents/writer.md': WRITER,
  };
  const parse = parseFactory(
    factoryFilesOf(texts, { 'incident-triage': TRIAGE, 'release-notes': NOTES }),
  );

  it('without `only`, every skill the read holds, each with its hash and files', () => {
    expect(parse.issues).toEqual([]);
    const all = appliedSkills(parse);
    expect(Object.keys(all).sort()).toEqual(['incident-triage', 'release-notes']);
    expect(all['incident-triage']).toEqual({
      hash: parse.skills['incident-triage'].hash,
      files: parse.skills['incident-triage'].files,
    });
    expect(all['incident-triage'].files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'queries.md',
    ]);
    expect(all['release-notes'].hash).toBe(parse.skills['release-notes'].hash);
  });

  it('with `only`, the skills of the agents those entries name', () => {
    expect(Object.keys(appliedSkills(parse, [entry(parse, 'triage')]))).toEqual([
      'incident-triage',
    ]);
    expect(Object.keys(appliedSkills(parse, [entry(parse, 'write')])).sort()).toEqual([
      'incident-triage',
      'release-notes',
    ]);
    // An entry with no agent, or none at all, keeps none.
    expect(appliedSkills(parse, [entry(parse, 'nightly')])).toEqual({});
    expect(appliedSkills(parse, [])).toEqual({});
  });

  it('an entry keeps nothing of an agent the read does not hold as valid', () => {
    const broken = parseFactory(
      factoryFilesOf(
        {
          ...texts,
          'agents/writer.md': WRITER.replace('harness: claude-work\n', 'tools: write\n'),
        },
        { 'incident-triage': TRIAGE, 'release-notes': NOTES },
      ),
    );
    expect(broken.agents.writer).toBeUndefined();
    // `write` as the clean read had it names the writer, which this read does not hold.
    expect(appliedSkills(broken, [entry(parse, 'write')])).toEqual({});
    expect(
      Object.keys(appliedSkills(broken, [entry(parse, 'triage'), entry(parse, 'write')])),
    ).toEqual(['incident-triage']);
    // Every valid skill is still the read's.
    expect(Object.keys(appliedSkills(broken)).sort()).toEqual(['incident-triage', 'release-notes']);
  });

  it("holds its own lists, not the parse's", () => {
    const all = appliedSkills(parse);
    all['incident-triage'].files.pop();
    expect(parse.skills['incident-triage'].files).toHaveLength(2);
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

  describe('while only server checks hold the changes back (2-C)', () => {
    const waiting = (
      files: string[],
      removed: string[] = [],
      blocking: FactorySpecIssue[] = [],
    ) => ({
      kind: 'keeps' as const,
      removed,
      blocking,
      waiting: files.map(issue),
    });

    it.each([
      [
        ['agents/investigator.md'],
        [],
        'Checking the MCP servers in agents/investigator.md; your changes apply once its harness answers. The version from 10:42 keeps running.',
      ],
      [
        ['agents/a.md', 'agents/b.md', 'agents/a.md'],
        [],
        'Checking the MCP servers in agents/a.md and agents/b.md; your changes apply once their harnesses answer. The version from 10:42 keeps running.',
      ],
      [
        ['agents/investigator.md'],
        ['old-digest'],
        '`old-digest` was removed. Checking the MCP servers in agents/investigator.md; the rest of your changes apply once its harness answers. The version from 10:42 keeps running.',
      ],
      [
        ['agents/a.md', 'agents/b.md'],
        ['a', 'b'],
        '`a` and `b` were removed. Checking the MCP servers in agents/a.md and agents/b.md; the rest of your changes apply once their harnesses answer. The version from 10:42 keeps running.',
      ],
    ])('waiting on %j, removing %j', (files, removed, message) => {
      expect(standingMessage(waiting(files, removed), AT, NOW)).toBe(message);
    });

    it('with a problem too, says the changes did not apply, and counts only the problem', () => {
      expect(
        standingMessage(
          waiting(['agents/investigator.md'], [], [issue('agents/reviewer.md')]),
          AT,
          NOW,
        ),
      ).toBe(
        "Your changes didn't apply: 1 problem in agents/reviewer.md. The version from 10:42 keeps running.",
      );
    });
  });

  it('words the time against `now`', () => {
    expect(standingMessage(keeps([issue('a')]), AT, new Date(2026, 10, 23, 9, 0))).toBe(
      "Your changes didn't apply: 1 problem in a. The version from 22 Nov 10:42 keeps running.",
    );
  });
});
