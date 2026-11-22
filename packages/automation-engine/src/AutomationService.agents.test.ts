import { describe, expect, it } from 'vitest';
import {
  automationVersion,
  factoryFilesOf,
  parseAutomationEntry,
  parseFactory,
  parseFactorySpec,
} from '@consola/factory-spec';
import {
  stepsHarness,
  turnReport,
  WORKSPACE_ID,
  type StepsHarness,
  type StepsHarnessOptions,
} from './steps/steps.test-helpers';

/*
 * A factory folder's automation files and agents, as the service reads them:
 * an entry in `automations/<name>.yaml`, a step that names `agents/<name>.md`,
 * the host asked about the agent's harness, the agent in the run's
 * definition, its launch request and its prompt, and saving where an entry
 * lives. Every entry still applies one by one here (the first-start rule).
 */

const REVIEWER =
  "---\nharness: claude-work\nmodel: opus\nmax_turns: 30\n---\nYou review catalog-portal's changes.\n";
const REVIEWER_FILE = 'agents/reviewer.md';
const CATALOG_REVIEW_FILE = 'automations/catalog-review.yaml';
const CATALOG_REVIEW = `on: { cron: "0 7 * * 1-5" }
scope: catalog-portal
mode: auto
steps:
  - id: look
    agent: reviewer
    outputs:
      verdict: { enum: [ok, look-again] }
  - id: tell
    prompt: Tell the team what the review found.
    reads: [look.handover]
`;
const CLAUDE_WORK = { name: 'Claude work', problem: null };
const TURNED_OFF =
  '`claude-work` is turned off: turn it on in Settings › Harnesses, or change `harness:`';
const ENTRY_NAME = 'catalog-review';

/** The folder every test here starts from: the entry in its own file, its agent, no factory.yml. */
async function folder(options: StepsHarnessOptions = {}): Promise<StepsHarness> {
  return stepsHarness({
    files: { [CATALOG_REVIEW_FILE]: CATALOG_REVIEW, [REVIEWER_FILE]: REVIEWER },
    agentHarnesses: { 'claude-work': CLAUDE_WORK },
    ...options,
  });
}

/** Run now, approved once (so its `auto` entry is accepted), and let its first step launch. */
async function runNow(h: StepsHarness) {
  const asked = (await h.service.trigger(WORKSPACE_ID, ENTRY_NAME))!;
  expect(asked.status).toBe('needs-approval');
  await h.service.approve(asked.id);
  await h.flush();
  return asked;
}

describe('an automation file', () => {
  it('an automation file runs, and its issues point at it', async () => {
    const h = await folder();
    expect(h.service.list(WORKSPACE_ID)).toMatchObject([
      { name: ENTRY_NAME, file: CATALOG_REVIEW_FILE, line: 1 },
    ]);
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();

    await h.writeFile(CATALOG_REVIEW_FILE, CATALOG_REVIEW.replace('mode: auto', 'mode: sometimes'));
    const { issues } = h.service.snapshot(WORKSPACE_ID);
    expect(issues).toContainEqual(
      expect.objectContaining({
        file: CATALOG_REVIEW_FILE,
        line: 3,
        automation: ENTRY_NAME,
        path: 'mode',
      }),
    );
  });

  it('an unknown agent leaves its entry out', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW.replace('agent: reviewer', 'agent: nope'),
        [REVIEWER_FILE]: REVIEWER,
      },
    });
    expect(h.service.list(WORKSPACE_ID)).toEqual([]);
    expect(h.service.snapshot(WORKSPACE_ID).issues).toContainEqual(
      expect.objectContaining({
        file: CATALOG_REVIEW_FILE,
        path: 'steps[0].agent',
        automation: ENTRY_NAME,
        message: '`nope` is not an agent here: there is no agents/nope.md.',
      }),
    );
  });
});

describe('a step that names an agent', () => {
  it('a step that names an agent runs on its harness and model, with its body', async () => {
    const h = await folder();
    const run = await runNow(h);
    expect(h.world.launches).toHaveLength(1);
    const [launch] = h.world.launches;
    expect(launch.step).toMatchObject({ id: 'look', maxTurns: 30 });
    expect(launch.step?.agent).toStrictEqual({
      name: 'reviewer',
      harnessId: 'claude-work',
      model: 'opus',
      mcpServers: [],
      skills: [],
    });
    expect(launch.prompt).toContain(
      "Your standing instructions (agents/reviewer.md):\nYou review catalog-portal's changes.",
    );
    expect(launch.prompt).not.toContain('This step:');

    const definition = h.service.getRunDefinition(run.id);
    expect(definition?.agents?.look).toMatchObject({
      name: 'reviewer',
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      harnessId: 'claude-work',
      model: 'opus',
      maxTurns: 30,
      body: "You review catalog-portal's changes.\n",
    });
    expect(h.store.get(run.id)?.steps?.[0]).toMatchObject({ id: 'look', agent: 'reviewer' });

    // The agent's cap reaches 2-A's record of the turn (Call 12).
    h.world.setOutputs('session-1', { verdict: 'ok' });
    await h.world.endTurn('session-1', { exitCode: 0, report: turnReport({ turns: 3 }) });
    expect(h.store.get(run.id)?.steps?.[0].turn).toMatchObject({ maxTurns: 30 });
  });

  it("the host is asked about the agent's harness, and its answer is the entry's problem", async () => {
    const h = await folder();
    h.world.agentHarnesses['claude-work'] = {
      name: 'Claude work',
      problem: null,
      agentProblem: TURNED_OFF,
    };
    await h.service.syncWorkspaces();
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBe(`agents/reviewer.md: ${TURNED_OFF}`);
    // Its node still names the agent's harness and model.
    expect(h.service.list(WORKSPACE_ID)[0].steps?.[0].agent).toBe('reviewer · claude-work · opus');
    await expect(h.service.trigger(WORKSPACE_ID, ENTRY_NAME)).rejects.toThrow(/cannot run/);
    expect(h.world.launches).toEqual([]);
    expect(h.world.harnessQueries).toContainEqual({
      harnessId: 'claude-work',
      model: 'opus',
      mcpServers: [],
      skills: [],
      checkout: 'scope',
    });
  });

  it("the host is asked about an agent with its entry's checkout kind (2-C)", async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        'automations/on-review.yaml':
          'on: { github: pull_request.review_requested }\nmode: confirm\nsteps:\n  - id: look\n    agent: reviewer\n',
      },
    });
    const kinds = new Set(h.world.harnessQueries.map((query) => query?.checkout));
    expect(kinds).toEqual(new Set(['scope', 'item', undefined]));
    expect(h.world.harnessQueries).toContainEqual({
      harnessId: 'claude-work',
      model: 'opus',
      mcpServers: [],
      skills: [],
      checkout: 'item',
    });
  });

  it('a warning shows as a notice, and stops nothing', async () => {
    const warning =
      '`opus` is not among the models Claude work lists; `--model` also takes a model’s full name, and a step on a model the CLI does not have fails.';
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        // A second entry on the same agent: the notice is given once.
        'automations/catalog-recheck.yaml': CATALOG_REVIEW.replace('0 7 * * 1-5', '0 12 * * 1-5'),
        [REVIEWER_FILE]: REVIEWER,
        // A folder a later slice reads: the read's own notice comes first.
        'environments/staging.yaml': 'isolation: host\n',
      },
      agentHarnesses: { 'claude-work': { ...CLAUDE_WORK, warning } },
    });
    expect(h.service.snapshot(WORKSPACE_ID).notices).toEqual([
      {
        message:
          '`environments/` is read from slice 3 (write steps); its files have no effect yet.',
      },
      { file: REVIEWER_FILE, line: 3, message: warning },
    ]);
    expect(h.service.list(WORKSPACE_ID).map((view) => view.problem)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('an entry whose every agent step names an agent does not need the default harness', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW.replace(
          '    prompt: Tell the team what the review found.',
          '    agent: reviewer\n    prompt: Tell the team what the review found.',
        ),
        [REVIEWER_FILE]: REVIEWER,
      },
      harness: { name: 'Claude', problem: 'it cannot run read-only.' },
    });
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
    // With a step on the default harness, its problem is the entry's.
    await h.writeFile(CATALOG_REVIEW_FILE, CATALOG_REVIEW);
    expect(h.service.list(WORKSPACE_ID)[0].problem).toBe(
      'Claude can’t run read-only automation sessions: it cannot run read-only',
    );
  });

  it("an entry that cannot run for its trigger still names its agent's harness and model", async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW.replace(
          'on: { cron: "0 7 * * 1-5" }\nscope: catalog-portal\n',
          'on: { github: pull_request.review_requested }\n',
        ),
        [REVIEWER_FILE]: REVIEWER,
      },
    });
    h.world.workspace.provider = undefined;
    await h.service.syncWorkspaces();
    const [view] = h.service.list(WORKSPACE_ID);
    expect(view.problem).toMatch(/no github account bound/);
    expect(view.steps?.[0].agent).toBe('reviewer · claude-work · opus');
  });

  it("a step without an agent is slice 1's", async () => {
    const h = await folder();
    const run = await runNow(h);
    h.world.setOutputs('session-1', { verdict: 'ok' });
    h.world.writeArtifact('session-1', 'handover', 'Nothing to change.');
    await h.world.endTurn('session-1', { exitCode: 0, report: turnReport({}) });
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.launches[1].step).toMatchObject({ id: 'tell' });
    expect(Object.prototype.hasOwnProperty.call(h.world.launches[1].step, 'agent')).toBe(false);
    expect(h.world.launches[1].prompt).not.toContain('Your standing instructions');
    // The step without an agent asks of the default harness, with no query.
    expect(h.world.harnessQueries).toContain(undefined);
    expect(h.store.get(run.id)?.steps?.[1]).not.toHaveProperty('agent');

    // An entry with no agent step: today's version and definition, exactly.
    const yaml = `version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: api
    mode: auto
    steps:
      - id: one
        prompt: Read what changed in api overnight.
`;
    const plain = await stepsHarness({ yaml });
    const [automation] = parseFactorySpec(yaml).automations;
    plain.store.accept(`${WORKSPACE_ID} nightly`, automationVersion(automation, undefined));
    await plain.service.syncWorkspaces();
    expect(plain.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    const nightly = (await plain.service.trigger(WORKSPACE_ID, 'nightly'))!;
    const definition = plain.service.getRunDefinition(nightly.id)!;
    expect(Object.prototype.hasOwnProperty.call(definition, 'agents')).toBe(false);
  });

  it('the version covers the agent', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        'agents/other.md': 'You are not used by anything.\n',
      },
    });
    await runNow(h);
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    // An agent file no entry names changes nothing.
    await h.writeFile('agents/other.md', 'You are still not used by anything.\n');
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBeUndefined();
    // One byte of the agent's body asks again.
    await h.writeFile(REVIEWER_FILE, REVIEWER.replace('changes.', 'changes!'));
    expect(h.service.list(WORKSPACE_ID)[0].asksFirst).toBe(true);
  });

  it('a retry runs what was approved', async () => {
    const h = await folder();
    const run = await runNow(h);
    await h.writeFile(REVIEWER_FILE, REVIEWER.replace('You review', 'You now review'));
    await h.world.endTurn('session-1', { exitCode: 1, report: turnReport({ isError: true }) });
    expect(h.store.get(run.id)?.status).toBe('failed');
    await h.service.retry(run.id, 'look');
    await h.flush();
    expect(h.world.launches).toHaveLength(2);
    expect(h.world.launches[1].prompt).toContain("You review catalog-portal's changes.");
    expect(h.world.launches[1].prompt).not.toContain('You now review');
  });

  it("names a step's agent with its harness and model, and its file", async () => {
    const h = await folder();
    expect(h.service.list(WORKSPACE_ID)[0].steps?.[0]).toMatchObject({
      id: 'look',
      agent: 'reviewer · claude-work · opus',
      agentFile: REVIEWER_FILE,
    });
  });
});

describe('saving where an entry lives', () => {
  const ITEM = `- name: ${ENTRY_NAME}\n  ${CATALOG_REVIEW.trimEnd().replace(/\n/g, '\n  ')}`;

  it('replaces an automation file in place, and adds new entries to factory.yml', async () => {
    const h = await folder({ yaml: 'version: 1\nautomations: []\n' });
    const replaced = await h.service.saveEntry(
      WORKSPACE_ID,
      ITEM.replace('Tell the team', 'Tell alice'),
      { replace: true },
    );
    expect(replaced).toMatchObject({ name: ENTRY_NAME, replaced: true, file: CATALOG_REVIEW_FILE });
    const written = h.texts().get(CATALOG_REVIEW_FILE)!;
    expect(written).toContain('Tell alice');
    expect(written).not.toMatch(/^name:/m);
    expect(h.texts().get('factory.yml')).toBe('version: 1\nautomations: []\n');

    const added = await h.service.saveEntry(
      WORKSPACE_ID,
      '- name: catalog-notes\n  on: { cron: "0 8 * * 1-5" }\n  scope: catalog-portal\n  steps:\n    - id: note\n      agent: reviewer\n',
      { replace: false },
    );
    expect(added).toMatchObject({ name: 'catalog-notes', replaced: false, file: 'factory.yml' });
    expect(h.texts().get('factory.yml')).toContain('- name: catalog-notes');
    expect(h.service.list(WORKSPACE_ID).map((view) => view.name)).toEqual([
      'catalog-notes',
      ENTRY_NAME,
    ]);
  });

  it("refuses a name an automation file holds without replace, in that file's words", async () => {
    const h = await folder();
    await expect(h.service.saveEntry(WORKSPACE_ID, ITEM, { replace: false })).rejects.toThrow(
      'Not saved: automations/catalog-review.yaml already has an automation named "catalog-review"; pass replace: true to replace it, or choose another name.',
    );
  });

  it('refuses an entry naming an agent the folder lacks', async () => {
    const h = await folder();
    await expect(
      h.service.saveEntry(WORKSPACE_ID, ITEM.replace('agent: reviewer', 'agent: nope'), {
        replace: true,
      }),
    ).rejects.toThrow(
      'Not saved: its step `look` names the agent `nope`, and agents/nope.md is not in this factory.',
    );
    expect(h.texts().get(CATALOG_REVIEW_FILE)).toBe(CATALOG_REVIEW);
  });

  it('refuses an entry naming an agent whose file has problems, saying so, not that it is missing (review M5)', async () => {
    const h = await folder();
    await h.writeFile(REVIEWER_FILE, '---\ntools: write\n---\nYou review.\n');
    await expect(h.service.saveEntry(WORKSPACE_ID, ITEM, { replace: true })).rejects.toThrow(
      'Not saved: its step `look` names the agent `reviewer`, which has problems of its own in agents/reviewer.md; save it once they are fixed.',
    );
    expect(h.texts().get(CATALOG_REVIEW_FILE)).toBe(CATALOG_REVIEW);
  });

  it('says the same of an agent the folder could not read: its agents/ links outside', async () => {
    const h = await folder();
    h.texts().delete(REVIEWER_FILE);
    h.world.outsidePaths = ['agents/'];
    await h.service.recheck(WORKSPACE_ID);
    await expect(h.service.saveEntry(WORKSPACE_ID, ITEM, { replace: true })).rejects.toThrow(
      'Not saved: its step `look` names the agent `reviewer`, which has problems of its own in agents/reviewer.md; save it once they are fixed.',
    );
  });
});

describe('the entry as written, and as an item', () => {
  it("an automation file's entry is its file, byte for byte; its item parses to the same automation", async () => {
    const h = await folder();
    expect(await h.service.entryText(WORKSPACE_ID, ENTRY_NAME)).toBe(CATALOG_REVIEW);
    expect(h.service.list(WORKSPACE_ID)[0].line).toBe(1);
    const item = await h.service.entryItem(WORKSPACE_ID, ENTRY_NAME);
    const parsed = parseAutomationEntry(item!);
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
    const [listed] = parseFactory(
      factoryFilesOf({ [CATALOG_REVIEW_FILE]: CATALOG_REVIEW, [REVIEWER_FILE]: REVIEWER }),
    ).automations;
    const { file: _file, line: _line, ...asListed } = listed;
    expect(parsed.automation).toEqual(asListed);
  });

  it('a name that is no name has no entry, and is never a path', async () => {
    const h = await folder();
    expect(await h.service.entryText(WORKSPACE_ID, '../catalog-review')).toBeNull();
    expect(await h.service.entryItem(WORKSPACE_ID, '../catalog-review')).toBeNull();
  });

  it("a factory.yml entry's text and item are today's item", async () => {
    const yaml =
      'version: 1\nautomations:\n  # The nightly look.\n  - name: nightly\n    on: { cron: "0 9 * * 1-5" }\n    scope: api\n    run: { prompt: Look. }\n';
    const h = await stepsHarness({ yaml });
    const item =
      '- name: nightly\n  on: { cron: "0 9 * * 1-5" }\n  scope: api\n  run: { prompt: Look. }';
    expect(await h.service.entryText(WORKSPACE_ID, 'nightly')).toBe(item);
    expect(await h.service.entryItem(WORKSPACE_ID, 'nightly')).toBe(item);
    expect(await h.service.entryText(WORKSPACE_ID, 'missing')).toBeNull();
    expect(await h.service.entryItem(WORKSPACE_ID, 'missing')).toBeNull();
  });
});

describe("a factory file's path, for Open", () => {
  const FOLDER = `/home/me/.consola/workspaces/${WORKSPACE_ID}`;

  it("gives one of the folder's own files by its path", async () => {
    const h = await folder();
    expect(await h.service.factoryFilePath(WORKSPACE_ID, REVIEWER_FILE)).toBe(
      `${FOLDER}/agents/reviewer.md`,
    );
    expect(await h.service.factoryFilePath(WORKSPACE_ID, CATALOG_REVIEW_FILE)).toBe(
      `${FOLDER}/automations/catalog-review.yaml`,
    );
  });

  it('refuses any other path', async () => {
    const h = await folder();
    await expect(h.service.factoryFilePath(WORKSPACE_ID, '../x')).rejects.toThrow(
      'Not a file of this factory: `../x`.',
    );
    await expect(h.service.factoryFilePath(WORKSPACE_ID, 'runs/r1')).rejects.toThrow(
      'Not a file of this factory: `runs/r1`.',
    );
  });

  it('with no path, creates factory.yml from the template and gives its path', async () => {
    const h = await folder();
    expect(h.texts().has('factory.yml')).toBe(false);
    expect(await h.service.factoryFilePath(WORKSPACE_ID)).toBe(`${FOLDER}/factory.yml`);
    expect(h.texts().get('factory.yml')).toContain('automations:');
    expect(await h.service.factoryFilePath(WORKSPACE_ID, 'factory.yml')).toBe(
      `${FOLDER}/factory.yml`,
    );
  });
});

describe('the assigned-reviews suggestion', () => {
  it('a broken agent file does not stop it: only a factory.yml that does not load does', async () => {
    const h = await folder({
      yaml: 'version: 1\nautomations: []\n',
      files: { [REVIEWER_FILE]: '---\ntools: write\n---\nYou write.\n' },
    });
    expect(h.service.snapshot(WORKSPACE_ID).issues).not.toEqual([]);
    expect(h.service.snapshot(WORKSPACE_ID).suggestAssignedReviews).toBe(true);
    await h.writeFile('factory.yml', 'automations: []\n');
    expect(h.service.snapshot(WORKSPACE_ID).suggestAssignedReviews).toBe(false);
  });
});

describe('the words that name a file (M7)', () => {
  it('addAssignedReviews refuses when its automation file exists', async () => {
    const h = await folder({
      files: {
        [CATALOG_REVIEW_FILE]: CATALOG_REVIEW,
        [REVIEWER_FILE]: REVIEWER,
        'automations/review-assigned-prs.yaml':
          'on: { cron: "0 9 * * *" }\nscope: catalog-portal\nrun: { prompt: Look. }\n',
      },
    });
    await expect(h.service.addAssignedReviews(WORKSPACE_ID)).rejects.toThrow(
      'automations/review-assigned-prs.yaml already has review-assigned-prs.',
    );
  });

  it("approving a waiting run names the entry's file, or says it is gone", async () => {
    const h = await folder();
    const first = (await h.service.trigger(WORKSPACE_ID, ENTRY_NAME))!;
    await h.writeFile(CATALOG_REVIEW_FILE, CATALOG_REVIEW.replace('Tell the team', 'Tell bob'));
    await expect(h.service.approve(first.id)).rejects.toThrow(
      'Not run: automations/catalog-review.yaml changed since this preview; run it again.',
    );
    const second = (await h.service.trigger(WORKSPACE_ID, ENTRY_NAME))!;
    await h.writeFile(CATALOG_REVIEW_FILE, null);
    await expect(h.service.approve(second.id)).rejects.toThrow(
      'Not run: it is no longer in its workspace’s factory.',
    );
    expect(h.world.launches).toEqual([]);
  });

  it('a queued run whose entry is gone is turned away without naming a file', async () => {
    const h = await folder({ maxConcurrentAgents: 0 });
    const asked = (await h.service.trigger(WORKSPACE_ID, ENTRY_NAME))!;
    await h.service.approve(asked.id);
    expect(h.store.get(asked.id)?.status).toBe('queued');
    await h.writeFile(CATALOG_REVIEW_FILE, null);
    h.world.maxConcurrentAgents = undefined;
    await h.tick();
    expect(h.store.get(asked.id)).toMatchObject({
      status: 'rejected',
      summary: 'It is no longer in its workspace’s factory.',
    });
    expect(h.world.launches).toEqual([]);
  });
});

describe("an entry's agents, with their servers and skills (2-C, Task 13)", () => {
  const INVESTIGATOR_FILE = 'agents/investigator.md';
  const INVESTIGATOR = (body: string) =>
    `---\ndescription: Investigates production alerts.\nharness: claude-work\nmodel: opus\nmax_turns: 40\nmcpServers:\n  - claude.ai Coralogix\n  - grafana: [query_logs]\nskills: [incident-triage]\n---\n${body}\n`;
  const SUMMARISER = '---\nharness: claude-work\nmodel: haiku\n---\nSUMMARISER-BODY-1\n';
  const TRIAGE =
    "---\nname: incident-triage\ndescription: The team's triage checklist.\n---\nCheck the last deploy first.\n";
  const steps = `steps:
  - id: investigate
    agent: investigator
  - id: summarise
    agent: summariser
  - id: again
    agent: investigator
`;
  const POLL = `on:\n  poll: { every: 5m, run: ./alerts, key: .ts }\nscope: catalog-portal\nmode: auto\n${steps}`;
  const files = (entry: string) => ({
    'automations/investigate-alerts.yaml': entry,
    [INVESTIGATOR_FILE]: INVESTIGATOR('INVESTIGATOR-BODY-1'),
    'agents/summariser.md': SUMMARISER,
    'skills/incident-triage/SKILL.md': TRIAGE,
  });
  const investigating = (entry = POLL) =>
    stepsHarness({ files: files(entry), agentHarnesses: { 'claude-work': CLAUDE_WORK } });

  it('gives each agent once, in step order, with its body, servers, skills and cap, at the version list gives', async () => {
    const h = await investigating();
    const listed = h.service.list(WORKSPACE_ID)[0];
    expect(listed.problem).toBeUndefined();
    expect(listed.version).toBeDefined();
    const view = h.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')!;
    expect(view.version).toBe(listed.version);
    expect(view.agents).toEqual([
      {
        name: 'investigator',
        file: INVESTIGATOR_FILE,
        description: 'Investigates production alerts.',
        harnessId: 'claude-work',
        model: 'opus',
        maxTurns: 40,
        body: 'INVESTIGATOR-BODY-1\n',
        mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
        skills: ['incident-triage'],
      },
      {
        name: 'summariser',
        file: 'agents/summariser.md',
        harnessId: 'claude-work',
        model: 'haiku',
        body: 'SUMMARISER-BODY-1\n',
        mcpServers: [],
        skills: [],
      },
    ]);
  });

  it("its version moves when an agent's body is edited and applies (review S1)", async () => {
    const h = await investigating();
    const before = h.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')!;
    await h.writeFile(INVESTIGATOR_FILE, INVESTIGATOR('INVESTIGATOR-BODY-2'));
    const after = h.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')!;
    expect(after.version).not.toBe(before.version);
    expect(after.version).toBe(h.service.list(WORKSPACE_ID)[0].version);
    expect(after.agents[0].body).toBe('INVESTIGATOR-BODY-2\n');
  });

  it('says whether its runs carry text other people wrote, whatever checkout it works in (review B3)', async () => {
    const poll = await investigating();
    expect(poll.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')?.readsItems).toBe(true);
    const cron = await investigating(
      `on: { cron: "0 7 * * 1-5" }\nscope: catalog-portal\nmode: auto\n${steps}`,
    );
    expect(cron.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')?.readsItems).toBe(false);
    const event = await investigating(
      `on: { github: pull_request.review_requested }\nmode: confirm\n${steps}`,
    );
    expect(event.service.list(WORKSPACE_ID)[0].problem).toBeUndefined();
    expect(event.service.entryAgents(WORKSPACE_ID, 'investigate-alerts')?.readsItems).toBe(true);
  });

  it("list gives an agent step its agent's servers and skills, and one naming neither none (review S3)", async () => {
    const h = await investigating();
    const [investigate, summarise] = h.service.list(WORKSPACE_ID)[0].steps!;
    expect(investigate).toMatchObject({
      id: 'investigate',
      servers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    });
    expect(Object.prototype.hasOwnProperty.call(summarise, 'servers')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(summarise, 'skills')).toBe(false);
  });

  it("a step's detail gives its agent as the run's definition holds it, and a command none", async () => {
    const h = await investigating(
      `on: { cron: "0 7 * * 1-5" }\nscope: catalog-portal\nmode: auto\nsteps:\n  - id: investigate\n    agent: investigator\n  - id: post\n    run: echo posted\n`,
    );
    const asked = (await h.service.trigger(WORKSPACE_ID, 'investigate-alerts'))!;
    await h.service.approve(asked.id);
    await h.flush();
    const definition = h.service.getRunDefinition(asked.id)!;
    const detail = h.service.getStepDetail(asked.id, 'investigate')!;
    expect(detail.agent).toEqual(definition.agents?.investigate);
    expect(detail.agent).toMatchObject({
      name: 'investigator',
      mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    });
    expect(h.service.getStepDetail(asked.id, 'post')).not.toHaveProperty('agent');
  });
});
