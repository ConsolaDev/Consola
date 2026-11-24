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
  TRUSTED_ITEM_FIELDS as SPEC_TRUSTED_ITEM_FIELDS,
} from '@consola/factory-spec';
import { connectionCatalog } from './connections';
import {
  AGENT_EXAMPLES,
  describeCapabilities,
  GRAMMAR_EXAMPLES,
  SECRETS_EXAMPLE,
  SECRETS_GRAMMAR,
  SERVERS_EXAMPLE,
  SERVERS_GRAMMAR,
  TRUSTED_ITEM_FIELDS,
  USES_EXAMPLE,
  USES_GRAMMAR,
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
      'A Jira bug to a pull request, in a sandbox',
    ]);
    // One name, one meaning: no two examples share an entry name.
    const names = GRAMMAR_EXAMPLES.map((example) => /^- name: (\S+)/.exec(example.entry)?.[1]);
    expect(new Set(names).size).toBe(names.length);

    for (const example of GRAMMAR_EXAMPLES) {
      const parsed = parseAutomationEntry(example.entry);
      if (!parsed.ok) throw new Error(`${example.title}: ${parsed.issues[0].message}`);
      // Each example appears in the grammar text as written.
      expect(grammar().grammar, example.title).toContain(example.entry);
      // One with files beside it resolves with them (slice 3-B, below).
      if (example.files) continue;

      const h = await sourcesHarness({
        tools: [CLEAN_UP],
        yaml: `version: 1\nautomations:\n${indent(example.entry, '  ')}\n`,
      });
      const [listed] = h.service.list(WORKSPACE_ID);
      expect(listed.name, example.title).toBe(parsed.automation.name);
      expect(listed.problem, example.title).toBeUndefined();
    }
  });

  it('the writing example parses clean with §4.1’s three agents and its environment, and resolves (slice 3-B)', async () => {
    const example = GRAMMAR_EXAMPLES.find(
      (candidate) => candidate.title === 'A Jira bug to a pull request, in a sandbox',
    )!;
    const files = example.files!;
    expect(Object.keys(files).sort()).toEqual([
      'agents/pre-pr-reviewer.md',
      'agents/triager.md',
      'agents/ui-bugfixer.md',
      'environments/sandboxed.yaml',
    ]);
    const yaml = `version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n${indent(example.entry, '  ')}\n`;
    const read = parseFactory(factoryFilesOf({ 'factory.yml': yaml, ...files }));
    expect(read.issues).toEqual([]);
    expect(read.agents['ui-bugfixer']).toMatchObject({ tools: 'write', environment: 'sandboxed' });
    expect(read.environments.sandboxed).toMatchObject({
      isolation: 'sandbox',
      network: ['registry.npmjs.org'],
      env: ['CI'],
    });
    // Each file appears in the grammar as written, under its path.
    for (const [file, text] of Object.entries(files))
      expect(grammar().grammar, file).toContain(`${file}:\n\n${text}`);
    // Under Call 9 a sandboxed agent cannot commit: Consola commits each step (the re-check's caveat).
    expect(files['agents/ui-bugfixer.md']).not.toContain('commit with');
    expect(files['agents/ui-bugfixer.md']).toContain(
      'Leave your changes in the checkout; Consola commits them after the step, and never commit or push yourself.',
    );
    // Resolved on a host that makes a run's checkout and holds a write agent to its environment.
    const h = await stepsHarness({
      yaml,
      files: { ...files },
      runCheckouts: true,
      agentHarnesses: { 'claude-work': { name: 'Claude work', problem: null } },
    });
    const [listed] = h.service.list(WORKSPACE_ID);
    expect(listed.name).toBe('ui-bug-to-pr');
    expect(listed.problem).toBeUndefined();
    expect(h.service.snapshot(WORKSPACE_ID).issues).toEqual([]);
  });

  it('tells an agent what a write step is: repos, its own checkout, write tools, environments, path artifacts (slice 3-B)', () => {
    const text = grammar().grammar;
    expect(text).toContain(
      [
        'Writing:',
        '- `repos:` in factory.yml lists the repositories a factory may write to, as `owner/name`.',
        '- `checkout: { repo, branch, from? }` on an automation gives each run a checkout of its own: a clone of `repo` whose git folder sits outside the checkout, on `branch` (a template starting with a literal folder, `fix/{{item.key}}`; also `{{item.number}}`, `{{run.id}}`) cut from the default branch or `from`. Consola commits what each agent step leaves (a `sandbox` agent cannot commit; on `host`, leaving the commit to Consola is a convention, and an agent\'s own commit is kept when the branch still descends from where its step started), checks the branch between steps, and never pushes: a `run:` step does (`git push origin "HEAD:refs/heads/$CONSOLA_BRANCH"`).',
        "- An agent file's `tools:` is `read-only`, `edit` (files) or `write` (files and a shell); `edit` and `write` need `environment: <name>` and a checkout the run owns, and run on Claude only.",
        "- `environments/<name>.yaml`: `isolation: host` (your machine as it is: a convention) or `isolation: sandbox` (macOS: its shell writes only in the checkout and Claude's shared temporary folder, reaches `network:` hosts only, gets `env:` names only and no token Consola holds, and cannot read the credential files in your home folder, your harnesses' profiles, each agent CLI's default profile or Consola's data; your keychain is another matter, where Git, `gh` and Claude usually keep their sign-ins: it can still ask macOS for your keychain items through `security`, and other files stay readable).",
        "- `artifacts: [{ name, path }]` on a write agent's step is a file it writes in the checkout; `reads: [checkout.changes]` and a gate's `show: [checkout.changes]` give the branch's diff.",
      ].join('\n'),
    );
    expect(text).toContain(
      '- tools: read-only (the default), edit or write; edit and write need environment: and a checkout the run owns.',
    );
    expect(text).not.toContain('the only value until write steps');
    // Canary row 49 (the conductor's binding): the sandbox does not keep the keychain service from the shell.
    expect(text).not.toContain('cannot read your keychain');
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
    // GH_TOKEN and GH_HOST are the bound account's (decision 37): named, and refused in env:.
    for (const name of ENV_PREFIX_EXCEPTIONS) {
      expect(line, name).toContain(name);
      expect(withEnv(name), name).toBe(false);
    }
    expect(line).toContain("(GH_TOKEN and GH_HOST are the bound account's: Consola sets them)");
    expect(line).not.toContain('are allowed');
  });

  it("re-exports factory-spec's trusted item fields, one list (review Minor 16)", () => {
    expect(TRUSTED_ITEM_FIELDS).toBe(SPEC_TRUSTED_ITEM_FIELDS);
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
    // An agent file's secrets are refused for good, not for later (5a-1).
    expect(text).toContain(
      'secrets (a secret given to an agent can reach its model, its transcript and its pane; a run: step names the secrets its command needs)',
    );
    expect(text).not.toContain('secrets (later slices)');
  });
});

describe('what an agent writing an entry is told of secrets', () => {
  it('teaches secrets: once, with an example that parses', () => {
    const parsed = parseAutomationEntry(SECRETS_EXAMPLE);
    if (!parsed.ok) throw new Error(parsed.issues[0].message);
    expect(
      parsed.automation.steps?.some(
        (step) => step.kind === 'run' && step.secrets?.join() === 'PAGERDUTY_TOKEN',
      ),
    ).toBe(true);
    const text = grammar().grammar;
    expect(text.split(SECRETS_GRAMMAR)).toHaveLength(2);
    expect(text.split(SECRETS_EXAMPLE)).toHaveLength(2);
    for (const words of [
      'secrets: [NAME, …]',
      '$NAME',
      'Settings › Secrets',
      'CLAUDE_CONFIG_DIR',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'at most 64 characters',
      'an agent file and an entry take none',
    ])
      expect(SECRETS_GRAMMAR, words).toContain(words);
    // What an agent is told never says where a value lives.
    for (const where of ['keychain:', 'op://', 'env:<'])
      expect(SECRETS_GRAMMAR, where).not.toContain(where);
  });

  it("echoes the workspace's names and whether each is bound", () => {
    const told = describeCapabilities({
      filePath: '/f/factory.yml',
      fileExists: true,
      tools: [],
      actions: [],
      scopes: [],
      taken: [],
      boundConnection: 'github',
      harness: { name: 'Claude', problem: null },
      secrets: [{ name: 'PAGER_TOKEN', bound: false }],
    });
    expect(told.secrets).toEqual([{ name: 'PAGER_TOKEN', bound: false }]);
    expect(grammar().secrets).toEqual([]);
    // Names and flags only, whatever a caller hands it.
    const labelled = {
      name: 'PAGER_TOKEN',
      bound: true,
      label: 'the keychain (consola/ws-1/personal · PAGER_TOKEN)',
    };
    const handed: Array<{ name: string; bound: boolean }> = [labelled];
    expect(
      describeCapabilities({
        filePath: '/f/factory.yml',
        fileExists: true,
        tools: [],
        actions: [],
        scopes: [],
        taken: [],
        boundConnection: 'github',
        harness: { name: 'Claude', problem: null },
        secrets: handed,
      }).secrets,
    ).toEqual([{ name: 'PAGER_TOKEN', bound: true }]);
  });

  it("names every kind of step in the steps' first sentence (the merge with slice 3)", () => {
    expect(grammar().grammar).toContain(
      'Each step has one of prompt:, action:, agent: <name>, run:, uses: (see Calls), gate: or repeat: (see Control flow in steps);',
    );
  });

  it('no longer lists secrets, uses or with as arriving with connections as data', () => {
    const line = grammar()
      .grammar.split('\n')
      .find((candidate) => candidate.startsWith('Not supported yet, refused with a reason:'))!;
    expect(line).not.toContain('`uses`, `with` arrive with connections as data');
    expect(line).not.toContain('connections as data');
    expect(line).not.toContain('`secrets`');
    // The other later keys are still listed; `gate` is a step since slice 3, so it is not.
    expect(line).not.toContain('`gate`');
    expect(line).toContain('`wait`, `concurrency` arrive with waiting runs');
    expect(line).toContain('`callable`, `inputs` arrive with callable automations');
  });
});

describe('what an agent writing automations is told of servers and calls (5a-2 Task 10)', () => {
  it('teaches mcpServers: with a factory.yml that parses with no issue and no notice', () => {
    const read = parseFactory(factoryFilesOf({ 'factory.yml': SERVERS_EXAMPLE }));
    expect(read.issues).toEqual([]);
    expect(read.notices).toEqual([]);
    expect(Object.keys(read.servers)).toEqual(['slack', 'tracker']);
    expect(read.servers.slack.transport).toBe('stdio');
    expect(read.servers.tracker.transport).toBe('http');
  });

  it('teaches uses: with an entry that parses and resolves against those servers', async () => {
    const parsed = parseAutomationEntry(USES_EXAMPLE);
    if (!parsed.ok) throw new Error(parsed.issues[0].message);
    expect(parsed.automation.steps?.map((step) => step.kind)).toEqual(['run', 'uses']);
    const h = await stepsHarness({
      yaml: SERVERS_EXAMPLE.replace(
        'automations: []',
        `automations:\n${indent(USES_EXAMPLE, '  ')}\n`,
      ),
      secrets: {
        bindings: { SLACK_BOT_TOKEN: { ref: 'keychain:slack' } },
        values: { SLACK_BOT_TOKEN: 'stub-slack-secret-9c1e' },
      },
    });
    const [listed] = h.service.list(WORKSPACE_ID);
    expect(listed.name).toBe('post-shipped');
    expect(listed.problem).toBeUndefined();
  });

  it('holds both paragraphs and both examples, once each', () => {
    const text = grammar().grammar;
    for (const part of [SERVERS_GRAMMAR, USES_GRAMMAR, SERVERS_EXAMPLE, USES_EXAMPLE])
      expect(text.split(part)).toHaveLength(2);
    for (const words of [
      'consola is reserved',
      'at most 20',
      'never a relative one',
      'headersHelper',
      'type: sse',
      'cwd',
      'oauth',
      'in an empty folder, as the person',
      'Pin a launched package',
      'ask again',
      'consola_save_automation writes entries, not mcpServers:',
      "An agent file's mcpServers: names its harness's servers, not these.",
    ])
      expect(SERVERS_GRAMMAR, words).toContain(words);
    for (const words of [
      'uses: <server>#<tool>',
      'Consola reads none of it',
      'Never .file',
      '{{secrets.X}}',
      'keeps the path',
      'default 60s, at most 10m',
      'unless dry_run: run',
      'is never repeated by Consola',
      'prompt or selector takes only trusted values',
      'run: { tool: consola#<tool>, with: … } keeps working',
    ])
      expect(USES_GRAMMAR, words).toContain(words);
    expect(text).toContain('connections/ once connection manifests arrive');
    expect(text).not.toContain('environments/, connections/ and evals/ are read from later slices');
  });

  it("echoes the factory's servers by name and transport, none when absent", () => {
    const told = (servers?: CapabilitiesServers) =>
      describeCapabilities({
        filePath: '/f/factory.yml',
        fileExists: true,
        tools: [],
        actions: [],
        scopes: [],
        taken: [],
        boundConnection: 'github',
        harness: { name: 'Claude', problem: null },
        ...(servers ? { servers } : {}),
      }).servers;
    expect(told([{ name: 'slack', transport: 'stdio' }])).toEqual([
      { name: 'slack', transport: 'stdio' },
    ]);
    expect(told()).toEqual([]);
    // Names, transports and descriptions only, whatever a caller hands it.
    const handed = [
      { name: 'tracker', transport: 'http' as const, url: 'https://x', headers: { a: 'b' } },
    ];
    expect(told(handed)).toEqual([{ name: 'tracker', transport: 'http' }]);
  });

  it('gives each tool argument its role, a selector when its tool gives none', () => {
    const tools = describeCapabilities({
      filePath: '/f/factory.yml',
      fileExists: true,
      tools: [
        { ...CLEAN_UP, roles: { pr_states: 'selector' } },
        {
          name: 'start_chat',
          description: 'Start a chat.',
          input: { prompt: z.string(), channel: z.string(), note: z.string() },
          roles: { prompt: 'prompt', channel: 'data' },
        },
      ],
      actions: [],
      scopes: [],
      taken: [],
      boundConnection: 'github',
      harness: { name: 'Claude', problem: null },
    }).targets.tools;
    expect(tools[0].arguments).toEqual([{ name: 'pr_states', description: '', role: 'selector' }]);
    expect(tools[1].arguments.map(({ name, role }) => [name, role])).toEqual([
      ['prompt', 'prompt'],
      ['channel', 'data'],
      ['note', 'selector'],
    ]);
  });

  it("tells an agent the workspace's servers through the service, and none of their values", async () => {
    const h = await stepsHarness({
      yaml: SERVERS_EXAMPLE,
      secrets: {
        bindings: {
          SLACK_BOT_TOKEN: {
            ref: 'keychain:slack',
            label: 'the keychain (consola/ws-1/personal · SLACK_BOT_TOKEN)',
          },
        },
      },
    });
    const told = h.service.capabilities(WORKSPACE_ID);
    expect(told.servers).toEqual([
      { name: 'slack', transport: 'stdio', description: "Posts to the team's Slack as its bot." },
      { name: 'tracker', transport: 'http' },
    ]);
    const text = JSON.stringify(told);
    const grammarText = told.grammar;
    // The grammar's own example names T0SPROCKET and the header's shape; nothing else in the answer does.
    const rest = text.split(JSON.stringify(grammarText).slice(1, -1)).join('');
    for (const value of ['T0SPROCKET', 'Bearer', 'keychain:slack', 'the keychain (consola'])
      expect(rest, value).not.toContain(value);
  });
});

type CapabilitiesServers = NonNullable<Parameters<typeof describeCapabilities>[0]['servers']>;
