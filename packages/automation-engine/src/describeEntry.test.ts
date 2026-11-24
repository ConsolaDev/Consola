import { describe, expect, it } from 'vitest';
import {
  isStepsEntry,
  parseFactory,
  parseFactorySpec,
  type AgentStep,
  type Automation,
  type GateStep,
  type StepsAutomation,
  type UsesStep,
} from '@consola/factory-spec';
import {
  describeEvery,
  describeFlow,
  describeKind,
  describeRun,
  describeSteps,
  dryRunReports,
  dryRunStarts,
  describeWrites,
  FILE_TOOL_LINKS_HEDGE,
  KEYCHAIN_SENTENCE,
  KEYCHAIN_SIGN_INS_SENTENCE,
  type WriteVersions,
} from './describeEntry';
import { agentRequirements } from './steps/definition';

describe('describeEvery', () => {
  it.each([
    [30 * 60_000, { words: '30 minutes', short: '30m' }],
    [60 * 60_000, { words: '1 hour', short: '1h' }],
    [90 * 60_000, { words: '90 minutes', short: '90m' }],
    [120 * 60_000, { words: '2 hours', short: '2h' }],
  ])('%i ms reads as %o', (ms, words) => {
    expect(describeEvery(ms)).toEqual(words);
  });
});

describe('describeSteps', () => {
  const step = (fields: Partial<AgentStep>): AgentStep => ({
    id: 'investigate',
    named: true,
    kind: 'agent',
    outputs: {},
    artifacts: [],
    reads: [],
    handover: 'optional',
    ...fields,
  });

  it('describes a gate by its question, with its choices and no command', () => {
    const gate: GateStep = {
      id: 'decide',
      named: true,
      kind: 'gate',
      if: "steps.investigate.verdict == 'approve'",
      ask: 'Post it as an approval?',
      show: ['investigate.handover'],
      choices: ['approve', 'comment'],
    };
    expect(describeSteps([gate, { ...gate, id: 'plain', choices: undefined }])).toEqual([
      {
        id: 'decide',
        kind: 'gate',
        if: "steps.investigate.verdict == 'approve'",
        summary: 'Post it as an approval?',
        ask: 'Post it as an approval?',
        choices: ['approve', 'comment'],
      },
      {
        id: 'plain',
        kind: 'gate',
        if: "steps.investigate.verdict == 'approve'",
        summary: 'Post it as an approval?',
        ask: 'Post it as an approval?',
      },
    ]);
  });

  it("names an agent-only step by its agent, and keeps a prompt's and an action's words", () => {
    expect(
      describeSteps([
        step({ agent: 'investigator' }),
        step({ id: 'summarise', agent: 'summariser', prompt: 'Write the reply.' }),
        step({ id: 'review', agent: 'reviewer', action: 'Review' }),
        step({ id: 'plain', prompt: 'Read it.' }),
      ]).map((described) => described.summary),
    ).toEqual(['investigator', 'Prompt', 'Review action', 'Prompt']);
  });

  it("gives an agent step its agent's words and file, and a step without one neither", () => {
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
    const described = describeSteps(
      [
        step({ agent: 'investigator' }),
        step({ id: 'summarise', agent: 'summariser', prompt: 'Write the reply.' }),
        step({ id: 'review', agent: 'investigator', action: 'Review' }),
        step({ id: 'tidy', agent: 'tidier' }),
        step({ id: 'plain', prompt: 'Read it.' }),
      ],
      {
        investigator: { harness: 'claude-work', model: 'opus' },
        summariser: {},
        tidier: { model: 'haiku' },
      },
    );
    expect(
      described.map(({ summary, agent, agentFile }) => ({ summary, agent, agentFile })),
    ).toEqual([
      {
        summary: 'investigator · claude-work · opus',
        agent: 'investigator · claude-work · opus',
        agentFile: 'agents/investigator.md',
      },
      { summary: 'Prompt', agent: 'summariser', agentFile: 'agents/summariser.md' },
      {
        summary: 'Review action',
        agent: 'investigator · claude-work · opus',
        agentFile: 'agents/investigator.md',
      },
      { summary: 'tidier · haiku', agent: 'tidier · haiku', agentFile: 'agents/tidier.md' },
      { summary: 'Prompt', agent: undefined, agentFile: undefined },
    ]);
    expect(own(described[4], 'agent')).toBe(false);
    expect(own(described[4], 'agentFile')).toBe(false);
  });

  it("gives an agent step its agent's servers and skills as the agent file has them (2-C, review S3)", () => {
    const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
    const described = describeSteps(
      [step({ agent: 'investigator' }), step({ id: 'summarise', agent: 'summariser' })],
      {
        investigator: {
          harness: 'stub-work',
          mcpServers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
          skills: ['incident-triage'],
        },
        summariser: { mcpServers: [], skills: [] },
      },
    );
    expect(described[0]).toMatchObject({
      servers: [{ name: 'claude.ai Coralogix' }, { name: 'grafana', tools: ['query_logs'] }],
      skills: ['incident-triage'],
    });
    expect(own(described[0].servers![0], 'tools')).toBe(false);
    // An agent naming neither, and 2-B's map (no servers or skills key), give neither key.
    expect(own(described[1], 'servers')).toBe(false);
    expect(own(described[1], 'skills')).toBe(false);
    const twoB = describeSteps([step({ agent: 'investigator' })], {
      investigator: { harness: 'claude-work' },
    });
    expect(own(twoB[0], 'servers')).toBe(false);
    expect(own(twoB[0], 'skills')).toBe(false);
  });

  it('names an agent the map lacks by its name alone', () => {
    expect(describeSteps([step({ agent: 'investigator' })])[0]).toMatchObject({
      summary: 'investigator',
      agent: 'investigator',
      agentFile: 'agents/investigator.md',
    });
  });

  it('names a call by its server and tool, and marks one that runs in a dry run (5a-2)', () => {
    const post = (fields: Partial<UsesStep> = {}): UsesStep => ({
      id: 'post',
      named: true,
      kind: 'uses',
      uses: 'slack#chat_post_message',
      server: 'slack',
      tool: 'chat_post_message',
      with: {},
      outputs: {},
      timeoutMs: 60_000,
      dryRun: 'report',
      ...fields,
    });
    expect(describeSteps([post()])).toEqual([
      { id: 'post', kind: 'uses', summary: 'slack#chat_post_message' },
    ]);
    expect(describeSteps([post({ dryRun: 'run' })])).toEqual([
      { id: 'post', kind: 'uses', summary: 'slack#chat_post_message', dryRun: true },
    ]);
  });
});

/** One parsed entry on review requests whose steps are the given lines. */
function looped(...lines: string[]): Automation {
  const result = parseFactorySpec(
    `version: 1\nautomations:\n  - name: a\n    on: { github: pull_request.review_requested }\n    steps:\n${lines
      .map((line) => `      ${line.replace(/\n/g, '\n      ')}`)
      .join('\n')}\n`,
  );
  if (result.issues.length > 0) throw new Error(JSON.stringify(result.issues));
  return result.automations[0];
}

const POLISH = [
  '- id: polish',
  '  repeat: { max: 3, until: steps.review.findings == 0 }',
  '  on_exhausted: { gate: "Open it anyway?" }',
  '  steps:',
  '    - id: review\n      prompt: Review it.\n      outputs: { findings: integer }',
  '    - id: address\n      if: steps.review.findings > 0\n      run: echo\n      dry_run: run',
].join('\n');

describe('an entry with a loop (slice 3)', () => {
  it('is an agent entry when its only agent step is inside the loop', () => {
    expect(describeKind(looped('- id: fetch\n  run: gh pr view', POLISH))).toBe('agent');
    expect(describeKind(looped('- id: fetch\n  run: gh pr view'))).toBe('tool');
  });

  it("says what it runs with the loop's steps in line", () => {
    expect(describeRun(looped('- id: fetch\n  run: gh pr view', POLISH))).toBe(
      'Steps: fetch → review → address',
    );
  });

  it('describes the loop, then its steps marked with it', () => {
    const automation = looped('- id: fetch\n  run: gh pr view', POLISH, '- id: pr\n  run: echo');
    if (!automation.steps) throw new Error('steps');
    const described = describeSteps(automation.steps);
    expect(described.map(({ id, kind, loop }) => [id, kind, loop])).toEqual([
      ['fetch', 'run', undefined],
      ['polish', 'repeat', undefined],
      ['review', 'agent', 'polish'],
      ['address', 'run', 'polish'],
      ['pr', 'run', undefined],
    ]);
    expect(described[1]).toEqual({
      id: 'polish',
      kind: 'repeat',
      summary: 'up to 3 rounds · until review.findings == 0',
      max: 3,
      until: 'steps.review.findings == 0',
      exhausted: 'gate',
    });
  });

  it("counts a loop's agent, or its dry_run: run command, as starting in a dry run", () => {
    const inner = (step: string) =>
      looped(
        `- id: polish\n  repeat: { max: 2, until: steps.s.ok }\n  steps:\n    - id: s\n${step.replace(/^/gm, '      ')}\n      outputs: { ok: boolean }`,
      );
    expect(dryRunStarts(inner('prompt: Look.').steps!)).toBe(true);
    expect(dryRunStarts(inner('run: echo\ndry_run: run').steps!)).toBe(true);
    expect(dryRunStarts(inner('run: echo').steps!)).toBe(false);
  });
});

/** One parsed `steps:` entry from its YAML list item. */
function parsedEntry(item: string): StepsAutomation {
  const result = parseFactorySpec(
    `version: 1\nautomations:\n${item.replace(/^/gm, '  ').replace(/^ +$/gm, '')}\n`,
  );
  if (result.issues.length > 0) throw new Error(JSON.stringify(result.issues));
  const [automation] = result.automations;
  if (!automation || !isStepsEntry(automation)) throw new Error('not a steps entry');
  return automation;
}

/**
 * North-star §4.1 as 3-A can parse it: no `checkout: { repo, branch }`, no
 * `checkout.changes`, and prompts for its agents (read without a folder).
 */
const SECTION_41 = parsedEntry(`- name: ui-bug-to-pr
  on:
    poll:
      every: 10m
      run: acli jira workitem search --json
      key: .key
  scope: catalog-portal
  mode: auto
  budget: { usd: 5 }
  steps:
    - id: triage
      prompt: Triage the ticket.
      outputs:
        kind: { enum: [bug, feature, unclear] }
    - id: not-ours
      if: steps.triage.kind != 'bug'
      run: acli jira workitem comment create --key "$KEY"
      env: { KEY: "{{item.key}}" }
      then: stop
    - id: fix
      prompt: Fix the bug described below.
      reads: [triage.handover]
    - id: polish
      repeat: { max: 3, until: steps.review.findings == 0 }
      steps:
        - id: review
          prompt: Review the fix.
          reads: [fix.handover]
          outputs: { findings: integer }
        - id: address
          if: steps.review.findings > 0
          prompt: Address the findings in the review handover.
          reads: [review.handover]
      on_exhausted:
        gate:
          ask: The review still has findings after 3 rounds. Open the pull request anyway?
          show: [review.handover]
    - id: pr
      run: gh pr create
    - id: ticket
      run: acli jira workitem transition --key "$KEY"
      env: { KEY: "{{item.key}}" }`);

/** The gated review's shape (Task 20 ships its template): a gate, no loop, no retry, no budget. */
const GATED_REVIEW = parsedEntry(`- name: review-gated
  on: { github: [pull_request.review_requested] }
  checkout: { pr: item }
  mode: auto
  steps:
    - id: fresh
      run: echo "needed=true" >> "$CONSOLA_OUTPUT"
      outputs: { needed: boolean }
      dry_run: run
    - id: review
      if: steps.fresh.needed
      prompt: Review it.
      outputs:
        verdict: { enum: [approve, comment, request-changes] }
    - id: decide
      if: steps.review.verdict == 'approve'
      gate:
        ask: Post the review as an approval?
        show: [review.handover]
        choices: [approve, comment]
    - id: publish-decided
      if: steps.decide.decision == 'approve'
      run: gh api reviews`);

/** A loop holding a command, a step retry and the entry's own. */
const LOOP_WITH_NOTIFY = parsedEntry(`- name: looped
  on: manual
  scope: catalog-portal
  mode: auto
  on_failure: { retry: 1 }
  steps:
    - id: polish
      repeat: { max: 3, until: steps.look.findings == 0 }
      steps:
        - id: look
          prompt: Count the findings.
          outputs: { findings: integer }
          on_failure: { retry: 2 }
        - id: notify-slack
          run: echo posted`);

describe('describeFlow (slice 3, the cards)', () => {
  it("writes §4.1's flow lines", () => {
    expect(describeFlow(SECTION_41)).toEqual([
      'Repeats `review` and `address` up to 3 times until `steps.review.findings == 0`; then asks you.',
      'Nothing retries by itself.',
      'Budget: $5 at most (est.).',
    ]);
  });

  it("writes the gated review's", () => {
    expect(describeFlow(GATED_REVIEW)).toEqual([
      'Stops for you at `decide`.',
      'Nothing retries by itself.',
      'No budget.',
    ]);
  });

  it('says how often a command inside a loop may run, and each declared retry', () => {
    expect(describeFlow(LOOP_WITH_NOTIFY)).toEqual([
      'Repeats `look` and `notify-slack` up to 3 times until `steps.look.findings == 0`; then fails.',
      '`notify-slack` runs once per round (up to 3 times).',
      // Inside a loop, a retry and a gate are each round's (3-A code review M7).
      '`look` retries by itself up to 2 times each round.',
      // A start again begins the loops again: `max` bounds each start, not the run.
      'The whole run starts again by itself up to 1 time, only if nothing in it acted, its loops from round 1.',
      'No budget.',
    ]);
  });

  it('joins three ids with commas, says `time` for 1, and a loop that goes on', () => {
    const automation = parsedEntry(`- name: three
  on: manual
  scope: catalog-portal
  mode: auto
  budget: { usd: 2.5 }
  steps:
    - id: once
      repeat: { max: 1, until: steps.a.done }
      on_exhausted: continue
      steps:
        - id: a
          prompt: A.
          outputs: { done: boolean }
          on_failure: { retry: 1 }
        - id: b
          run: echo b
          dry_run: run
          on_failure: { retry: 3 }
        - id: c
          prompt: C.
    - id: ask
      gate: { ask: Go on? }
    - id: last
      run: echo last`);
    expect(describeFlow(automation)).toEqual([
      'Repeats `a`, `b` and `c` up to 1 time until `steps.a.done`; then goes on.',
      'Stops for you at `ask`.',
      '`b` runs once per round (up to 1 time).',
      '`a` retries by itself up to 1 time each round.',
      '`b` retries by itself up to 3 times each round.',
      'Budget: $2.5 at most (est.).',
    ]);
  });

  it('names a gate inside a loop, and counts no retry of 0', () => {
    const automation = parsedEntry(`- name: inner
  on: manual
  scope: catalog-portal
  mode: auto
  on_failure: { retry: 0 }
  steps:
    - id: polish
      repeat: { max: 2, until: steps.look.ok }
      steps:
        - id: look
          prompt: Look.
          outputs: { ok: boolean }
          on_failure: { retry: 0 }
        - id: check
          gate: { ask: Still going? }
    - id: solo
      prompt: Solo.`);
    expect(describeFlow(automation)).toEqual([
      'Repeats `look` and `check` up to 2 times until `steps.look.ok`; then fails.',
      'Stops for you at `check` each round.',
      'Nothing retries by itself.',
      'No budget.',
    ]);
  });

  it('says a top-level retry and gate once, and an entry retry with no loop as before (3-A code review M7)', () => {
    const automation = parsedEntry(`- name: flat
  on: manual
  scope: catalog-portal
  mode: auto
  on_failure: { retry: 2 }
  steps:
    - id: look
      prompt: Look.
      on_failure: { retry: 1 }
    - id: decide
      gate: { ask: Go on? }`);
    expect(describeFlow(automation)).toEqual([
      'Stops for you at `decide`.',
      '`look` retries by itself up to 1 time.',
      'The whole run starts again by itself up to 2 times, only if nothing in it acted.',
      'No budget.',
    ]);
  });

  it('writes a single-step loop and an entry with none', () => {
    const solo = parsedEntry(`- name: solo
  on: manual
  scope: catalog-portal
  mode: auto
  steps:
    - id: polish
      repeat: { max: 4, until: steps.look.ok }
      on_exhausted: fail
      steps:
        - id: look
          prompt: Look.
          outputs: { ok: boolean }`);
    expect(describeFlow(solo)[0]).toBe(
      'Repeats `look` up to 4 times until `steps.look.ok`; then fails.',
    );
    const plain = parsedEntry(`- name: plain
  on: manual
  scope: catalog-portal
  mode: auto
  steps:
    - id: only
      prompt: Only.`);
    expect(describeFlow(plain)).toEqual(['Nothing retries by itself.', 'No budget.']);
  });
});

describe('a dry run and a write step (slice 3-B)', () => {
  const agentStep = (id: string, agent?: string): AgentStep => ({
    kind: 'agent',
    id,
    named: true,
    prompt: 'Fix it.',
    ...(agent !== undefined ? { agent } : {}),
    outputs: {},
    artifacts: [],
    reads: [],
    handover: 'optional',
  });

  it('a dry run reports a write step, and runs read-only ones', () => {
    expect(dryRunStarts([agentStep('fix', 'fixer')], { fixer: { tools: 'write' } })).toBe(false);
    expect(dryRunStarts([agentStep('fix', 'fixer')], { fixer: { tools: 'edit' } })).toBe(false);
    expect(
      dryRunReports(agentStep('fix', 'fixer'), {
        fixer: { tools: 'write', environment: { name: 'sandboxed' } },
      }),
    ).toBe('Would have run fixer in sandboxed');
  });

  it('a read-only agent, or a step on the default harness, still runs', () => {
    const agents = { reader: { tools: 'read-only' as const }, fixer: { tools: 'write' as const } };
    expect(dryRunStarts([agentStep('look', 'reader')], agents)).toBe(true);
    expect(dryRunStarts([agentStep('look')], agents)).toBe(true);
    expect(dryRunStarts([agentStep('fix', 'fixer'), agentStep('look', 'reader')], agents)).toBe(
      true,
    );
    expect(dryRunReports(agentStep('look', 'reader'), agents)).toBeNull();
    expect(dryRunReports(agentStep('look'), agents)).toBeNull();
    // Without the agents (every caller before write agents), as before.
    expect(dryRunStarts([agentStep('fix', 'fixer')])).toBe(true);
  });
});

describe('describeWrites: what the approval card says a write agent can change, read, reach and run (slice 3-B Task 21)', () => {
  const ENTRY_41 = `version: 1
repos: [sprocket/catalog-portal]
automations:
  - name: ui-bug-to-pr
    on: { github: pull_request.review_requested }
    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.key}}" }
    steps:
      - id: triage
        agent: triager
        prompt: "Triage {{item.key}}."
        outputs: { kind: { enum: [bug, feature, unclear] } }
      - id: not-ours
        if: steps.triage.kind != 'bug'
        run: acli jira workitem comment create --key "$KEY"
        env: { KEY: "{{item.key}}" }
        then: stop
      - id: fix
        agent: ui-bugfixer
        prompt: "Fix {{item.key}}."
      - id: polish
        repeat: { max: 3, until: steps.review.findings == 0 }
        on_exhausted: { gate: "Review still has findings after 3 rounds" }
        steps:
          - id: review
            agent: pre-pr-reviewer
            outputs: { findings: integer }
          - id: address
            if: steps.review.findings > 0
            agent: ui-bugfixer
            prompt: "Address the findings in the review handover."
      - id: pr
        run: git push -u origin HEAD
      - id: ticket
        run: acli jira workitem transition --key "$KEY" --status "In Review"
        env: { KEY: "{{item.key}}" }
`;
  const agentFile = (front: string) => `---\n${front}---\nYou do the step.\n`;
  const ENVIRONMENTS = {
    sandboxed: 'isolation: sandbox\nnetwork: [registry.npmjs.org]\nenv: [CI]\n',
    open: 'isolation: host\n',
    closed: 'isolation: sandbox\n',
  };
  function parsed(factoryYml: string, agents: Record<string, string>) {
    const result = parseFactory({
      factoryYml,
      automations: {},
      agents,
      skills: {},
      environments: ENVIRONMENTS,
      stray: [],
      laterFolders: [],
      unread: [],
      outside: [],
    });
    if (result.issues.length > 0) throw new Error(JSON.stringify(result.issues));
    const [automation] = result.automations;
    if (!automation || !isStepsEntry(automation)) throw new Error('not a steps entry');
    const requirements = Object.fromEntries(
      Object.entries(result.agents).map(([name, agent]) => [
        name,
        agentRequirements(agent, result.environments),
      ]),
    );
    return { automation, agents: requirements };
  }
  const AGENTS_41 = {
    triager: agentFile('harness: claude-work\nmodel: haiku\n'),
    'ui-bugfixer': agentFile(
      'harness: claude-work\nmodel: sonnet\ntools: write\nenvironment: sandboxed\n',
    ),
    'pre-pr-reviewer': agentFile('harness: claude-work\nmodel: sonnet\n'),
  };
  const V: WriteVersions = {
    checkedOn: '2.1.330',
    running: { 'ui-bugfixer': '2.1.331' },
    hostEditChecked: true,
    fileToolsChecked: true,
    fileToolLinksChecked: true,
  };
  const LINE = (id: string) =>
    `\`${id}\` · on host, after ui-bugfixer: runs code an agent changed, as you, with your logins.`;
  const SANDBOX_WRITE_41 = [
    "Can change files only in this run's checkout of sprocket/catalog-portal, on `fix/<ticket>`, and in the temporary folder all your sandboxed Claude shells share.",
    'Can reach only registry.npmjs.org from its shell; its connectors: none.',
    'Gets CI from your environment and no token Consola holds.',
    "Its shell cannot read the credential files in your home folder (SSH, cloud, `gh`, npm, Git's), your harnesses' profiles, each agent CLI's default profile or Consola's data; its file tools read only this run's checkout.",
    'Your keychain is another matter: Git, `gh` and Claude usually keep their sign-ins there.',
    'Its shell can ask macOS for your keychain items through `security` (macOS may or may not ask you first).',
    'Its shell can read other files on this Mac, and send them to the hosts above, to its connectors, or into the branch a later step pushes.',
    '`git clone` and `git init` do not work in its shell.',
    'Consola shows no live attention for it while it runs: the sandbox keeps its hooks out.',
  ].join(' ');

  it("§4.1's card, exactly", () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    expect(describeWrites(automation, agents, V)).toEqual({
      checkout:
        "Cuts `fix/<ticket>` from sprocket/catalog-portal's default branch, in a checkout of its own. Nothing else is written.",
      agents: [
        {
          agent: 'ui-bugfixer',
          head: 'ui-bugfixer · claude-work · sonnet · writes files and runs commands · environment sandboxed (sandbox, enforced on this Mac) · checked on Claude 2.1.330; this Mac runs 2.1.331',
          sentences: [SANDBOX_WRITE_41],
        },
      ],
      // Review S4: both run after the write steps, on host; `not-ours` runs before any.
      commands: [LINE('pr'), LINE('ticket')],
      variables: 'Passes from your environment: CI.',
    });
  });

  it('never says the shell cannot read sign-ins the keychain holds, nor profiles no harness names (3-B code review F1)', () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    const [sentence] = describeWrites(automation, agents, V)!.agents[0].sentences;
    expect(sentence).not.toMatch(/Git credentials|other Claude profiles|cannot read your keychain/);
    expect(sentence).toContain(`${KEYCHAIN_SIGN_INS_SENTENCE} ${KEYCHAIN_SENTENCE}`);
    expect(KEYCHAIN_SIGN_INS_SENTENCE).toBe(
      'Your keychain is another matter: Git, `gh` and Claude usually keep their sign-ins there.',
    );
  });

  it('never says the sandbox keeps the keychain from its shell (canary row 49)', () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    const said = JSON.stringify(describeWrites(automation, agents, V));
    expect(said).not.toMatch(/cannot read your keychain|not your keychain/);
    expect(said).toContain(KEYCHAIN_SENTENCE);
    expect(KEYCHAIN_SENTENCE).toBe(
      'Its shell can ask macOS for your keychain items through `security` (macOS may or may not ask you first).',
    );
  });

  it('until canary row 50 passes, the card says whether the file tools follow a link out of the checkout is not yet checked (3-B code review F6)', () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    const HEDGE = 'Whether its file tools follow a link out of the checkout is not yet checked.';
    expect(FILE_TOOL_LINKS_HEDGE).toBe(HEDGE);
    const unchecked = { ...V, fileToolLinksChecked: false };
    expect(describeWrites(automation, agents, unchecked)!.agents[0].sentences[0]).toContain(
      `Consola's data; its file tools read only this run's checkout. ${HEDGE} Your keychain`,
    );
    for (const isolation of ['host', 'sandbox'] as const)
      expect(
        blockFor('edit', isolation, { fileToolLinksChecked: false }).agents[0].sentences[0],
      ).toContain(`a later step pushes. ${HEDGE} Its connectors: none.`);
    // Once it passed, no hedge; and none where the file tools were not checked at all (that sentence says so).
    expect(JSON.stringify(describeWrites(automation, agents, V))).not.toContain(HEDGE);
    expect(
      describeWrites(automation, agents, { ...unchecked, fileToolsChecked: false })!.agents[0]
        .sentences[0],
    ).not.toContain(HEDGE);
  });

  it('until rows 44/45 pass, the card names the shell only (review B1)', () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    expect(
      describeWrites(automation, agents, { ...V, fileToolsChecked: false })!.agents[0].sentences[0],
    ).toContain("Consola's data; its file tools were not checked against that list.");
  });

  /** An entry whose one step runs a `tools` agent on `isolation`, then a command. */
  function blockFor(
    tools: 'edit' | 'write',
    isolation: 'host' | 'sandbox',
    versions: Partial<WriteVersions> = {},
  ) {
    const yml = `version: 1
repos: [sprocket/catalog-portal]
automations:
  - name: one
    on: { github: pull_request.review_requested }
    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.number}}", from: release }
    steps:
      - id: change
        agent: changer
        prompt: Change it.
`;
    const env = isolation === 'host' ? 'open' : 'sandboxed';
    const { automation, agents } = parsed(yml, {
      changer: agentFile(`tools: ${tools}\nenvironment: ${env}\n`),
    });
    return describeWrites(automation, agents, { ...V, running: {}, ...versions })!;
  }

  it.each([
    [
      'write',
      'host',
      'Has a shell with your logins, your network and your files: it can change anything you can. Blocking `git push` and `gh` is a convention it can go around.',
    ],
    [
      'edit',
      'host',
      "Changes files only in this run's checkout (no shell). Its file tools read only this run's checkout, by the same `--restricted` (seen with the sandbox on), and what it reads can end up in the branch a later step pushes. Its connectors: none.",
    ],
    [
      'edit',
      'sandbox',
      "Changes files only in this run's checkout (no shell). Its file tools read only this run's checkout, and what it reads can end up in the branch a later step pushes. Its connectors: none.",
    ],
  ] as const)('a %s agent on %s says what it is', (tools, isolation, sentence) => {
    expect(blockFor(tools, isolation).agents[0].sentences).toEqual([sentence]);
  });

  it('an edit agent says it has no shell, whatever its environment (review M3)', () => {
    const named = { host: 'open', sandbox: 'sandboxed' } as const;
    for (const isolation of ['host', 'sandbox'] as const) {
      expect(blockFor('edit', isolation).agents[0].head).toContain(
        `writes files · environment ${named[isolation]} (no shell; its files are confined by --restricted)`,
      );
    }
    expect(blockFor('edit', 'sandbox').agents[0].head).not.toContain('checked on Claude');
    // No shell, so no keychain, network or git sentence: those are a shell's.
    expect(blockFor('edit', 'sandbox').agents[0].sentences[0]).not.toContain('keychain');
  });

  it('an edit agent on host keeps its hedge until canary row 30 passed', () => {
    expect(blockFor('edit', 'host', { hostEditChecked: false }).agents[0].sentences[0]).toContain(
      'that it can change nothing else is not yet checked on host',
    );
    expect(blockFor('edit', 'sandbox', { hostEditChecked: false }).agents[0].sentences[0]).toMatch(
      /^Changes files only in this run's checkout \(no shell\)\./,
    );
    expect(blockFor('edit', 'host', { fileToolsChecked: false }).agents[0].sentences[0]).toContain(
      'What its file tools can read outside the checkout was not checked',
    );
  });

  it('a write agent on host has no sandbox line, and the run passes it your whole environment', () => {
    const host = blockFor('write', 'host');
    expect(host.agents[0].head).toBe(
      'changer · default harness · default model · writes files and runs commands · environment open (host, a convention)',
    );
    expect(host).not.toHaveProperty('variables');
    expect(host.checkout).toBe(
      "Cuts `fix/<number>` from sprocket/catalog-portal's branch `release`, in a checkout of its own. Nothing else is written.",
    );
  });

  it('a sandboxed write agent with no network and no variables says so', () => {
    const yml = `version: 1
repos: [sprocket/catalog-portal]
automations:
  - name: closed
    on: { github: pull_request.review_requested }
    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{run.id}}" }
    steps:
      - id: change
        agent: changer
        prompt: Change it.
`;
    const { automation, agents } = parsed(yml, {
      changer: agentFile(
        'harness: claude-work\ntools: write\nenvironment: closed\nmcpServers: [claude.ai Linear]\n',
      ),
    });
    const written = describeWrites(automation, agents, V)!;
    expect(written.agents[0].sentences[0]).toContain(
      'Can reach no network from its shell; its connectors: claude.ai Linear.',
    );
    expect(written.agents[0].sentences[0]).toContain(
      'Gets nothing from your environment and no token Consola holds.',
    );
    expect(written.agents[0].sentences[0]).toContain(
      'Its shell can read other files on this Mac, and send them to its connectors or into the branch a later step pushes.',
    );
    expect(written.variables).toBe('Passes nothing from your environment.');
    expect(written.checkout).toContain('Cuts `fix/<run>`');
  });

  it("a command after a write step says it runs the agent's code as you; one inside its loop counts from round 1", () => {
    const yml = `version: 1
repos: [sprocket/catalog-portal]
automations:
  - name: tested
    on: { github: pull_request.review_requested }
    checkout: { repo: sprocket/catalog-portal, branch: "fix/{{item.key}}" }
    steps:
      - id: lint
        run: npm run lint
      - id: polish
        repeat: { max: 2, until: steps.check.ok == true }
        steps:
          - id: test
            run: npm test
          - id: check
            agent: ui-bugfixer
            prompt: Fix what failed.
            outputs: { ok: boolean }
`;
    const { automation, agents } = parsed(yml, { 'ui-bugfixer': AGENTS_41['ui-bugfixer'] });
    // `test` runs before `check` in round 1 and after it in round 2; `lint` never after a write.
    expect(describeWrites(automation, agents, V)!.commands).toEqual([LINE('test')]);
  });

  it('equal versions name only the checked one; an unknown one says so; none checked says so', () => {
    const { automation, agents } = parsed(ENTRY_41, AGENTS_41);
    const head = (versions: Partial<WriteVersions>) =>
      describeWrites(automation, agents, { ...V, ...versions })!.agents[0].head;
    expect(head({ running: { 'ui-bugfixer': '2.1.330' } })).toMatch(
      /· checked on Claude 2\.1\.330$/,
    );
    expect(head({ running: {} })).toMatch(
      /· checked on Claude 2\.1\.330; this Mac's version is not known$/,
    );
    expect(head({ checkedOn: null })).toMatch(/· not yet checked on any Claude version$/);
  });

  it('nothing for an entry with no write agent and no checkout of its own', () => {
    const yml = `version: 1
automations:
  - name: read
    on: { github: pull_request.review_requested }
    checkout: { pr: item }
    steps:
      - id: review
        agent: pre-pr-reviewer
      - id: post
        run: gh pr comment
`;
    const { automation, agents } = parsed(yml, { 'pre-pr-reviewer': AGENTS_41['pre-pr-reviewer'] });
    expect(describeWrites(automation, agents, V)).toBeUndefined();
  });
});
