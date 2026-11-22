import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ENV_PREFIX_EXCEPTIONS,
  factoryFilesOf,
  LATER_KEYS,
  parseAutomationEntry,
  parseFactory,
  REFUSED_ENV_NAMES,
  REFUSED_ENV_PREFIXES,
} from '@consola/factory-spec';
import { connectionCatalog } from './connections';
import {
  AGENT_EXAMPLES,
  describeCapabilities,
  GRAMMAR_EXAMPLES,
  TRUSTED_ITEM_FIELDS,
} from './capabilities';
import { defineTool } from './tools.test-helpers';
import { sourcesHarness } from './sources/sources.test-helpers';
import { skillFilesOf, stepsHarness, WORKSPACE_ID } from './steps/steps.test-helpers';

const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map((line) => `${by}${line}`)
    .join('\n');

const CLEAN_UP = defineTool({
  name: 'cleanup_stale_sessions',
  description: 'Clean up sessions whose pull requests are done.',
  input: { pr_states: z.array(z.enum(['merged', 'closed'])).optional() },
  mutating: true,
  automatable: true,
  preview: async () => ({ summary: 'Would clean up.', data: null }),
  run: async () => ({ summary: 'Cleaned up.', data: null }),
});

const grammar = () =>
  describeCapabilities({
    filePath: '/f/factory.yml',
    fileExists: true,
    tools: [],
    actions: [],
    scopes: [],
    taken: [],
    boundConnection: 'github',
    harness: { name: 'Claude', problem: null },
  });

describe('the harness, as an agent writing an entry is told it', () => {
  const told = (harness: Parameters<typeof describeCapabilities>[0]['harness']) =>
    describeCapabilities({
      filePath: '/f/factory.yml',
      fileExists: true,
      tools: [],
      actions: [],
      scopes: [],
      taken: [],
      boundConnection: 'github',
      harness,
    }).harness;

  it('tells an agent when the harness cannot run steps', () => {
    expect(
      told({ name: 'Claude', problem: null, stepProblem: 'Claude can’t run automation steps: x' }),
    ).toEqual({
      name: 'Claude',
      canRunAgents: true,
      stepsProblem: 'Claude can’t run automation steps: x',
    });
  });

  it('says nothing of steps when they would run', () => {
    expect(told({ name: 'Claude', problem: null, stepProblem: null })).toEqual({
      name: 'Claude',
      canRunAgents: true,
    });
    expect(told({ name: 'Claude', problem: null })).toEqual({ name: 'Claude', canRunAgents: true });
  });
});

describe('what an agent writing an entry is told', () => {
  it('every GRAMMAR example parses and resolves', async () => {
    expect(GRAMMAR_EXAMPLES.map((example) => example.title)).toEqual([
      'A tool, on a schedule',
      'An action, on an event',
      'A prompt, on a schedule',
      'Steps, on an event',
      'Steps, on a poll',
      'Steps with a turn cap, on a schedule',
      'A review loop with a gate, on an event',
    ]);
    // One name, one meaning: no two examples share an entry name.
    const names = GRAMMAR_EXAMPLES.map((example) => /^- name: (\S+)/.exec(example.entry)?.[1]);
    expect(new Set(names).size).toBe(names.length);

    for (const example of GRAMMAR_EXAMPLES) {
      const parsed = parseAutomationEntry(example.entry);
      if (!parsed.ok) throw new Error(`${example.title}: ${parsed.issues[0].message}`);
      // Each example appears in the grammar text as written.
      expect(grammar().grammar, example.title).toContain(example.entry);

      const h = await sourcesHarness({
        tools: [CLEAN_UP],
        yaml: `version: 1\nautomations:\n${indent(example.entry, '  ')}\n`,
      });
      const [listed] = h.service.list(WORKSPACE_ID);
      expect(listed.name, example.title).toBe(parsed.automation.name);
      expect(listed.problem, example.title).toBeUndefined();
    }
  });

  it('tells an agent the control flow of steps, and that no tool answers a gate (slice 3)', () => {
    const text = grammar().grammar;
    expect(text).toContain(
      [
        'Control flow in steps:',
        '- `gate: { ask, show?, choices? }` is a step of its own: the run waits, with no process, until a person answers in Consola. Its output is `decision` (one of `choices`, or `approve`); Reject ends the run. No tool answers a gate.',
        '- `repeat: { max, until }` with `steps:` (1 to 10, no loop inside) runs them again until `until` holds, at most `max` (1 to 10) rounds; `on_exhausted:` is `fail` (the default), `continue`, `{ gate: "<question>" }` or `{ gate: { ask, show } }`.',
        '- `then: stop` on a step ends the run, completed, once that step completes.',
        '- `on_failure: { retry: <0-3> }` on a step retries it by itself only if it cannot have acted: an agent naming no MCP server, or a `dry_run: run` command. On the automation, the whole run starts again only if nothing in it acted.',
        "- `budget: { usd: <n> }` on the automation stops the run at its next step once its agents' turns cost that much (0.01 to 1000).",
        "- `checkout: { pr: item }` names the pull request's read-only checkout, where a run on a pull request works anyway.",
      ].join('\n'),
    );
  });

  it('tells an agent about max_turns, and no longer calls it unsupported', () => {
    const text = grammar().grammar;
    expect(text).toContain("- max_turns: 1 to 500, an agent step's turn cap");
    const unsupported = text
      .split('\n')
      .find((line) => line.startsWith('Not supported yet, refused with a reason:'));
    expect(unsupported).toBeDefined();
    expect(unsupported).not.toContain('max_turns');
  });

  it('the grammar names every refused key and $CONSOLA_OUTPUT', () => {
    const text = grammar().grammar;
    for (const [key, arrivesWith] of Object.entries(LATER_KEYS)) {
      expect(text, key).toContain(`\`${key}\``);
      expect(text, `${key} arrives with`).toContain(arrivesWith);
    }
    expect(text).toContain('$CONSOLA_OUTPUT');
    expect(text).toContain('from: stdout');
    expect(text).toContain(
      'Set every declared output or the step fails; at most 64 KB; no key<<EOF form.',
    );
    expect(text).toContain('step-<n> and previous are refused as ids');
    expect(text).toContain('never handover or output');
    expect(text).toContain('1 to 20 values, each 1 to 64 characters, no line breaks');
    expect(text).toContain('{{ }} works only in prompt: and env:, never in run:');
    expect(text).toContain(
      "your login environment and the workspace's bound account, in the item's own checkout or the scope folder, with git hooks off. In a pull request's checkout, a command that builds or tests runs the author's code.",
    );
  });

  it('the env: names and prefixes the prose says are refused are the ones the validator refuses', () => {
    const text = grammar().grammar;
    const line = text.split('\n').find((candidate) => candidate.startsWith('- env: '));
    expect(line).toMatch(
      /^- env: these names and prefixes are refused because they make a program run a value: /,
    );
    const withEnv = (name: string) =>
      parseAutomationEntry(
        `- name: probe\n  on: { github: pull_request.review_requested }\n  steps:\n    - run: echo hi\n      env: { ${name}: x }`,
      ).ok;
    for (const name of REFUSED_ENV_NAMES) {
      expect(line, name).toContain(name);
      expect(withEnv(name), name).toBe(false);
    }
    for (const prefix of REFUSED_ENV_PREFIXES) {
      expect(line, prefix).toContain(`${prefix}*`);
      expect(withEnv(`${prefix}X`), prefix).toBe(false);
    }
    for (const name of ENV_PREFIX_EXCEPTIONS) {
      expect(line, name).toContain(name);
      expect(withEnv(name), name).toBe(true);
    }
  });

  it('the trusted list in the prose is the one the validator enforces', async () => {
    const text = grammar().grammar;
    expect(text).toContain(`item.${TRUSTED_ITEM_FIELDS.join(', ')}`);
    const fields = ['key', 'url', 'repo', 'number', 'type', 'title', 'author'];
    for (const field of fields) {
      const yaml =
        'version: 1\nautomations:\n  - name: probe\n    on: { github: pull_request.review_requested }\n' +
        `    steps:\n      - prompt: "Look at {{item.${field}}}."\n`;
      const trusted = parseAutomationEntry(yaml.split('automations:\n')[1]).ok;
      expect(trusted, field).toBe(TRUSTED_ITEM_FIELDS.includes(field));
    }
  });

  it('the enum and reserved-name limits in the prose match the validator', () => {
    const entry = (outputs: string, id = 'a') =>
      `- name: probe\n  on: { github: pull_request.review_requested }\n  steps:\n    - id: ${id}\n      prompt: Look.\n      outputs: ${outputs}`;
    const enumOf = (values: string[]) =>
      `{ v: { enum: [${values.map((v) => JSON.stringify(v)).join(', ')}] } }`;
    const twenty = Array.from({ length: 20 }, (_, i) => `v${i}`);
    expect(parseAutomationEntry(entry(enumOf(twenty))).ok).toBe(true);
    expect(parseAutomationEntry(entry(enumOf([...twenty, 'v20']))).ok).toBe(false);
    expect(parseAutomationEntry(entry(enumOf(['x'.repeat(64)]))).ok).toBe(true);
    expect(parseAutomationEntry(entry(enumOf(['x'.repeat(65)]))).ok).toBe(false);
    expect(parseAutomationEntry(entry('{ handover: boolean }')).ok).toBe(false);
    expect(parseAutomationEntry(entry('{ output: boolean }')).ok).toBe(false);
    expect(parseAutomationEntry(entry('{ ok: boolean }', 'step-1')).ok).toBe(false);
    expect(parseAutomationEntry(entry('{ ok: boolean }', 'previous')).ok).toBe(false);
  });

  it('READ_ONLY_LIMITS says posting is a run: step', () => {
    const limits = grammar().readOnlyLimits;
    expect(limits).toMatch(/^An automation’s agent session/);
    expect(
      limits.endsWith(
        "Posting or changing something is a run: step with the vendor's CLI (gh), after the read-only agent step.",
      ),
    ).toBe(true);
  });

  it('notify says a dry run, and that it asks once first', () => {
    const notify = grammar().modes.find((mode) => mode.mode === 'notify')?.means ?? '';
    expect(notify).toMatch(/dry run/);
    expect(notify).toMatch(/asks once first/);
  });

  it('auto says a run an agent asks for runs once and never lets the entry run on its own', () => {
    // The user's decision of 2026-11-21.
    const auto = grammar().modes.find((mode) => mode.mode === 'auto')?.means ?? '';
    expect(auto).toContain(
      'A run asked for with consola_run_automation always waits for the person, and approving it runs that run only: it never lets the entry run on its own.',
    );
  });

  it('refires is set for review_requested only', () => {
    const events = grammar().triggers.connections.find(
      (connection) => connection.id === 'github',
    )!.events;
    expect(events.map((event) => [event.name, event.refires, event.refiresWhen])).toEqual([
      ['pull_request.review_requested', true, 'fires again each time the review is re-requested'],
      ['pull_request.assigned', false, undefined],
    ]);
    expect(connectionCatalog()[0].events.filter((event) => event.refires)).toHaveLength(1);
  });

  it('the grammar says a poll waits for Allow and baselines', () => {
    const text = grammar().grammar;
    expect(text).toContain(
      "It is how to trigger on anything a CLI can answer, including what Consola's own events do not cover",
    );
    expect(text).toContain(
      'An item that leaves the result is forgotten, so it fires again when it comes back; while it stays, it fires again only when its changed: value moves.',
    );
    expect(text).toContain(
      'Changing the command, the item or changed: path, the timeout or the steps asks again; changing only every: does not.',
    );
    expect(text).not.toContain('a changed command or schedule asks again');
    expect(text).toContain('The command does the filtering');
    expect(text).toContain('--jq');
    expect(text).toContain('A poll does not check until the person allows it');
    expect(text).toContain('A new one records what is there on its first check and fires nothing');
    expect(text).toContain('a JSON array of objects, one per item');
    const { triggers } = grammar();
    expect(triggers.poll).toContain('does not check until the person allows it');
    expect(triggers.poll).toContain('records what is there and fires nothing');
    expect(triggers.manual).toContain('applies_to');
    expect(text).toContain('on: manual');
    expect(text).toContain('applies_to:');
  });

  it('previous is said to be empty on the first run', () => {
    const text = grammar().grammar;
    expect(text).toContain('previous.<step>.<artifact>');
    expect(text).toContain('It works in reads: and env: only');
    expect(text).toContain('It is empty on the first run');
  });
});

describe('what an agent writing agent files and automation files is told', () => {
  /** The grammar's factory.yml envelope: an example's entries live in their own files. */
  const ENVELOPE = 'version: 1\nautomations: []\n';

  it('every agent example parses with its folder and resolves', async () => {
    expect(AGENT_EXAMPLES.map((example) => example.title)).toEqual([
      'An agent on a schedule',
      'An investigator with a connector and a skill',
    ]);
    for (const example of AGENT_EXAMPLES) {
      const read = parseFactory(
        factoryFilesOf(
          { 'factory.yml': ENVELOPE, ...example.files },
          skillFilesOf(new Map(Object.entries(example.files))),
        ),
      );
      expect(read.issues, example.title).toEqual([]);
      expect(read.notices, example.title).toEqual([]);
      expect(read.automations.length, example.title).toBeGreaterThan(0);
      expect(Object.keys(read.agents).length, example.title).toBeGreaterThan(0);
      // Each file appears in the grammar as written, under its path.
      for (const [file, text] of Object.entries(example.files))
        expect(grammar().grammar, file).toContain(`${file}:\n\n${text}`);

      // Resolved on a workspace whose host answers every harness clean.
      const h = await stepsHarness({
        yaml: ENVELOPE,
        files: { ...example.files },
        agentHarnesses: { 'claude-work': { name: 'Claude work', problem: null } },
      });
      const listed = h.service.list(WORKSPACE_ID);
      expect(listed.map((view) => view.name)).toEqual(
        read.automations.map((automation) => automation.name),
      );
      for (const view of listed) expect(view.problem, view.name).toBeUndefined();
      expect(h.service.snapshot(WORKSPACE_ID).issues).toEqual([]);
    }
  });

  it('the investigator example names a connector, a narrowed server and a skill, on a keyed poll in a scope (2-C)', () => {
    const example = AGENT_EXAMPLES.find(
      (candidate) => candidate.title === 'An investigator with a connector and a skill',
    )!;
    const read = parseFactory(
      factoryFilesOf(
        { 'factory.yml': ENVELOPE, ...example.files },
        skillFilesOf(new Map(Object.entries(example.files))),
      ),
    );
    expect(read.agents.investigator).toMatchObject({
      harness: 'claude-work',
      mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    });
    expect(Object.keys(read.skills)).toEqual(['incident-triage']);
    const [automation] = read.automations;
    expect(automation).toMatchObject({ name: 'investigate-alerts', scope: expect.any(String) });
    expect(automation.trigger).toMatchObject({ kind: 'poll', key: expect.anything() });
  });

  it("tells an agent the workspace's agents and harnesses", async () => {
    const reviewer = {
      name: 'reviewer',
      description: "Reviews catalog-portal's changes.",
      harness: 'claude-work',
      model: 'opus',
      maxTurns: 30,
      mcpServers: [],
      skills: [],
    };
    const told = describeCapabilities({
      filePath: '/f/factory.yml',
      fileExists: true,
      tools: [],
      actions: [],
      scopes: [],
      taken: [],
      boundConnection: null,
      harness: { name: 'Claude', problem: null },
      agents: [{ ...reviewer, mcpServers: ['notion'], skills: ['incident-triage'] }],
      harnesses: [
        { id: 'claude', name: 'Claude' },
        { id: 'claude-work', name: 'Claude work' },
      ],
      folderPath: '/home/alice/.consola/workspaces/ws-1',
    });
    expect(told.agents).toEqual([
      { ...reviewer, mcpServers: ['notion'], skills: ['incident-triage'] },
    ]);
    expect(told.harnesses).toEqual([
      { id: 'claude', name: 'Claude' },
      { id: 'claude-work', name: 'Claude work' },
    ]);
    expect(told.folder).toEqual({ path: '/home/alice/.consola/workspaces/ws-1' });
    // Without the three, none and none, and the file's own folder.
    const bare = grammar();
    expect(bare.agents).toEqual([]);
    expect(bare.harnesses).toEqual([]);
    expect(bare.folder).toEqual({ path: '/f' });

    // A workspace's: the agents its folder holds, and the harnesses an agent may name.
    const h = await stepsHarness({
      yaml: ENVELOPE,
      files: {
        'agents/reviewer.md': `---\ndescription: Reviews catalog-portal's changes.\nharness: claude-work\nmodel: opus\nmax_turns: 30\nmcpServers:\n  - notion\n  - grafana: [query_logs]\n---\nYou review catalog-portal's changes.\n`,
        'agents/broken.md': '---\ntools: write\n---\nYou write.\n',
      },
    });
    h.world.harnessRecords = [
      { id: 'claude', name: 'Claude', enabled: true, archived: false },
      { id: 'claude-work', name: 'Claude work', enabled: true, archived: false },
      { id: 'claude-old', name: 'Claude old', enabled: true, archived: true },
      { id: 'claude-off', name: 'Claude off', enabled: false, archived: false },
    ];
    const capabilities = h.service.capabilities(WORKSPACE_ID);
    // Its servers by name: what each grants is the host's to say (2-C).
    expect(capabilities.agents).toEqual([{ ...reviewer, mcpServers: ['notion', 'grafana'] }]);
    expect(capabilities.harnesses).toEqual([
      { id: 'claude', name: 'Claude' },
      { id: 'claude-work', name: 'Claude work' },
    ]);
    expect(capabilities.folder).toEqual({ path: '/home/me/.consola/workspaces/ws-1' });
  });

  it('says when an agent edit asks again, and how a body that opens with a rule is written', () => {
    const text = grammar().grammar;
    expect(text).toContain(
      'An edit to an agent file or a skill makes every automation that uses it ask again before its next unattended run; a poll entry stops checking until the person allows it.',
    );
    expect(text).toContain(
      'A file whose first line is --- begins with its frontmatter, so a body that should open with a Markdown rule (---) needs frontmatter first, even an empty one: a line ---, then a line ---.',
    );
  });

  it("teaches an agent's servers and skills, and no longer says they arrive later (2-C)", () => {
    const text = grammar().grammar;
    // 2-B's sentence, which said they do not apply yet (quoted in part: no file may hold it now, review S10).
    expect(text).not.toContain('names mcpServers or skills does not apply yet');
    expect(text).toContain(
      "On a step that works in someone else's checkout (a pull request or issue), only claude.ai connectors are offered.",
    );
    expect(text).toContain(
      'Naming a server grants every tool it has, writing ones included; narrow it to named tools with - <server>: [<tool>, …].',
    );
  });

  it("tells an agent each harness's servers, once its CLI has been asked (2-C)", async () => {
    const told = describeCapabilities({
      filePath: '/f/factory.yml',
      fileExists: true,
      tools: [],
      actions: [],
      scopes: [],
      taken: [],
      boundConnection: null,
      harness: { name: 'Claude', problem: null },
      harnesses: [
        { id: 'claude', name: 'Claude' },
        { id: 'claude-work', name: 'Claude work', servers: ['notion', 'claude.ai Coralogix'] },
      ],
    });
    expect(told.harnesses).toEqual([
      { id: 'claude', name: 'Claude' },
      { id: 'claude-work', name: 'Claude work', servers: ['notion', 'claude.ai Coralogix'] },
    ]);
    expect(Object.prototype.hasOwnProperty.call(told.harnesses[0], 'servers')).toBe(false);

    // A workspace's: the host's records, with the names its last settled probe listed.
    const h = await stepsHarness({ yaml: 'version: 1\nautomations: []\n' });
    h.world.harnessRecords = [
      { id: 'claude', name: 'Claude', enabled: true, archived: false },
      {
        id: 'claude-work',
        name: 'Claude work',
        enabled: true,
        archived: false,
        servers: ['claude.ai Coralogix', 'grafana'],
      },
    ];
    expect(h.service.capabilities(WORKSPACE_ID).harnesses).toEqual([
      { id: 'claude', name: 'Claude' },
      { id: 'claude-work', name: 'Claude work', servers: ['claude.ai Coralogix', 'grafana'] },
    ]);
  });

  it('teaches the folder, agent files, automation files and skills', () => {
    const text = grammar().grammar;
    for (const section of ['The factory folder.', 'Agent files.', 'Automation files.', 'Skills.'])
      expect(text, section).toContain(`\n\n${section} `);
    // A step's agent is said where steps are: one of four, or beside a prompt or an action.
    expect(text).toContain('agent: <name>');
    expect(text).not.toContain('Each step has exactly one of prompt:, action: or run:.');
    // A binary is not scanned for a command at load (review S2).
    expect(text).toContain(
      'a command at load (the characters ! and ` together) anywhere in SKILL.md, in a file with a text extension, or in any file that is valid UTF-8 (a binary, such as an image or a font, is not read for it).',
    );
    // Card text is visible text (the validator differential).
    expect(text).toContain(
      "It, a server's name and the model are visible text: letters, numbers, punctuation, symbols and plain spaces",
    );
    // An editor's leftovers are passed over (review S5).
    expect(text).toContain('such as x.md~, #x.md#, x.orig or Thumbs.db, are passed over');
    // A link out of the folder is never read (review S3).
    expect(text).toContain(
      'a link leading outside the folder: Consola reads only files inside it.',
    );
  });
});
