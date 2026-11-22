import { describe, expect, it } from 'vitest';
import { factoryFilesOf, parseFactory, type FactoryFiles } from './factory';
import { parseFactorySpec } from './parse';
import type { SkillFileEntry } from './skills';

const files = (over: Partial<FactoryFiles> = {}): FactoryFiles => ({
  factoryYml: null,
  automations: {},
  agents: {},
  skills: {},
  stray: [],
  laterFolders: [],
  unread: [],
  ...over,
});
const text = (path: string, content: string): SkillFileEntry => ({
  path,
  bytes: new TextEncoder().encode(content),
});

// The spec's acceptance folder (*Acceptance › North-star §4.2's investigator*).
const INVESTIGATE_ALERTS = `on:
  poll:
    every: 5m
    run: |
      curl -sS -G https://slack.com/api/conversations.history \\
          -H "Authorization: Bearer $SLACK_BOT_TOKEN" -d channel=C0ALERTS01 -d limit=20 |
        jq 'if .ok then [.messages[] | { ts, channel: "C0ALERTS01", title: (.text | split("\\n")[0]), text }]
            else error(.error) end'
    key: .ts
scope: ops-notes
mode: auto
steps:
  - id: investigate
    agent: investigator
    outputs:
      severity: { enum: [noise, low, high] }
  - id: summarise
    if: steps.investigate.severity != 'noise'
    agent: summariser
    prompt: Write the reply for the alert's thread, in at most eight lines, from the investigation.
    reads: [investigate.handover]
    max_turns: 6
  - id: reply
    if: steps.investigate.severity != 'noise'
    run: |
      curl -sS -X POST https://slack.com/api/chat.postMessage \\
        -H "Authorization: Bearer $SLACK_BOT_TOKEN" \\
        --data-urlencode "channel=$CHANNEL" --data-urlencode "thread_ts=$TS" \\
        --data-urlencode "text@$BODY_FILE" | jq -e .ok
    env: { CHANNEL: "{{item.channel}}", TS: "{{item.ts}}", BODY_FILE: "{{steps.summarise.handover.file}}" }
`;
const INVESTIGATOR = `---
description: Investigates production alerts for the catalog-portal services.
harness: claude-work
model: opus
mcpServers: [claude.ai Coralogix]
skills: [incident-triage]
max_turns: 40
---
You investigate production alerts for the catalog-portal services. Start from the alert's query,
correlate logs and traces in Coralogix, and end with cause, impact and the next action. Set
severity: noise if nothing is wrong, low if it can wait for working hours, high otherwise.
`;
const SUMMARISER = `---
description: Writes short replies for alert threads.
harness: claude-personal
model: haiku
---
You write replies for an on-call channel: plain sentences, no headings, the action first.
`;
const TRIAGE: SkillFileEntry[] = [
  text(
    'SKILL.md',
    "---\nname: incident-triage\ndescription: The team's triage checklist.\n---\nCheck the alert first.\n",
  ),
  text('queries.md', 'Use rate() over five minutes.\n'),
];
const EMPTY_YML = 'version: 1\nautomations:\n';
const ACCEPTANCE = (): FactoryFiles =>
  files({
    factoryYml: EMPTY_YML,
    automations: { 'investigate-alerts': INVESTIGATE_ALERTS },
    agents: { investigator: INVESTIGATOR, summariser: SUMMARISER },
    skills: { 'incident-triage': TRIAGE },
  });
const names = (result: ReturnType<typeof parseFactory>) =>
  result.automations.map((automation) => automation.name);

describe('parseFactory', () => {
  it('the acceptance folder parses clean', () => {
    const result = parseFactory(ACCEPTANCE());
    expect(result.issues).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.automations).toHaveLength(1);
    const [automation] = result.automations;
    expect(automation).toMatchObject({
      name: 'investigate-alerts',
      file: 'automations/investigate-alerts.yaml',
      line: 1,
    });
    expect(
      automation.steps?.map((step) => (step.kind === 'agent' ? step.agent : step.kind)),
    ).toEqual(['investigator', 'summariser', 'run']);
    expect(result.agents.investigator.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(result.agents).sort()).toEqual(['investigator', 'summariser']);
    expect(result.skills['incident-triage']).toMatchObject({ name: 'incident-triage' });
    expect(result.present.sort()).toEqual([
      'agents/investigator.md',
      'agents/summariser.md',
      'automations/investigate-alerts.yaml',
      'factory.yml',
      'skills/incident-triage',
    ]);
    expect(result.unreadable).toEqual([]);
  });

  it("hashes an agent with its skills' hashes", () => {
    const before = parseFactory(ACCEPTANCE()).agents.investigator.hash;
    const edited = ACCEPTANCE();
    edited.skills['incident-triage'] = [
      TRIAGE[0],
      text('queries.md', 'Use rate() over ten minutes.\n'),
    ];
    expect(parseFactory(edited).agents.investigator.hash).not.toBe(before);
    expect(parseFactory(edited).agents.summariser.hash).toBe(
      parseFactory(ACCEPTANCE()).agents.summariser.hash,
    );
  });

  it('a factory.yml alone parses as parseFactorySpec does, but with files', () => {
    const yml = `version: 1
automations:
  - name: clean-up
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
    mode: auto
  - name: digest
    on: { cron: "30 8 * * 1-5" }
    run: { prompt: "Summarise my Inbox." }
    scope: api
    mode: auto
  - name: review
    on: { github: pull_request.review_requested }
    steps:
      - prompt: Review this pull request.
        outputs: { verdict: { enum: [approve, comment] } }
  - name: broken
    on: { cron: "0 9 * * *" }
    run: { tool: consola#x }
    mode: sometimes
`;
    const folder = parseFactory(files({ factoryYml: yml }));
    const alone = parseFactorySpec(yml);
    expect(folder.automations).toEqual(
      alone.automations.map((automation) => ({ ...automation, file: 'factory.yml' })),
    );
    expect(folder.issues).toEqual(alone.issues.map((issue) => ({ ...issue, file: 'factory.yml' })));
    expect(folder.present).toEqual(['factory.yml']);
    expect(folder.unreadable).toEqual([]);
  });

  describe('references', () => {
    it('refuses a step that names an agent the folder does not have, and leaves its entry out', () => {
      const folder = ACCEPTANCE();
      delete folder.agents.summariser;
      const result = parseFactory(folder);
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message: '`summariser` is not an agent here: there is no agents/summariser.md.',
          file: 'automations/investigate-alerts.yaml',
          path: 'steps[1].agent',
          line: 19,
          automation: 'investigate-alerts',
        },
      ]);
    });

    it('points at the step in factory.yml when the entry lives there', () => {
      const result = parseFactory(
        files({
          factoryYml:
            'version: 1\nautomations:\n  - name: triage\n    on: { cron: "0 9 * * *" }\n    scope: ops\n    steps:\n      - agent: noter\n',
        }),
      );
      expect(result.automations).toEqual([]);
      expect(result.issues).toEqual([
        {
          message: '`noter` is not an agent here: there is no agents/noter.md.',
          file: 'factory.yml',
          path: 'automations[0].steps[0].agent',
          line: 7,
          automation: 'triage',
        },
      ]);
    });

    it("says an agent whose own file has problems is why the step's entry is left out", () => {
      const folder = ACCEPTANCE();
      folder.agents.summariser = SUMMARISER.replace('model: haiku', 'model: haiku\ntools: write');
      const result = parseFactory(folder);
      expect(names(result)).toEqual([]);
      expect(Object.keys(result.agents)).toEqual(['investigator']);
      expect(result.issues).toMatchObject([
        {
          file: 'agents/summariser.md',
          path: 'tools',
          message: expect.stringMatching(/^Write tools/),
        },
        {
          file: 'automations/investigate-alerts.yaml',
          path: 'steps[1].agent',
          message:
            '`summariser` has problems of its own in agents/summariser.md; this step runs once they are fixed.',
        },
      ]);
    });

    it('refuses an agent that names a skill the folder does not have, at its skills: line', () => {
      const folder = ACCEPTANCE();
      folder.skills = {};
      const result = parseFactory(folder);
      expect(Object.keys(result.agents)).toEqual(['summariser']);
      expect(names(result)).toEqual([]);
      expect(result.issues).toMatchObject([
        {
          file: 'agents/investigator.md',
          path: 'skills',
          line: 6,
          message:
            '`incident-triage` is not a skill here: there is no skills/incident-triage/SKILL.md.',
        },
        {
          file: 'automations/investigate-alerts.yaml',
          path: 'steps[0].agent',
          message:
            '`investigator` has problems of its own in agents/investigator.md; this step runs once they are fixed.',
        },
      ]);
    });

    it('refuses an agent that names a skill with problems of its own', () => {
      const folder = ACCEPTANCE();
      folder.skills['incident-triage'] = [TRIAGE[0], { path: 'link.md', kind: 'symlink' }];
      const result = parseFactory(folder);
      expect(result.skills).toEqual({});
      expect(result.issues).toMatchObject([
        { file: 'skills/incident-triage/link.md' },
        {
          file: 'agents/investigator.md',
          path: 'skills',
          message:
            '`incident-triage` has problems of its own in skills/incident-triage/; this agent applies once they are fixed.',
        },
        { file: 'automations/investigate-alerts.yaml', path: 'steps[0].agent' },
      ]);
    });

    it('takes one skill named by two agents', () => {
      const folder = ACCEPTANCE();
      folder.agents.summariser = SUMMARISER.replace(
        'model: haiku',
        'model: haiku\nskills: [incident-triage]',
      );
      const result = parseFactory(folder);
      expect(result.issues).toEqual([]);
      expect(result.agents.summariser.skills).toEqual(['incident-triage']);
    });
  });

  it('refuses the same name twice, on both, keeping neither', () => {
    const folder = ACCEPTANCE();
    folder.factoryYml = `version: 1
automations:
  - name: investigate-alerts
    on: { cron: "0 9 * * *" }
    scope: ops-notes
    steps:
      - prompt: Look at the alerts.
`;
    const result = parseFactory(folder);
    expect(names(result)).toEqual([]);
    const message =
      '`investigate-alerts` is defined twice: in factory.yml (line 3) and in automations/investigate-alerts.yaml.';
    expect(result.issues).toEqual([
      {
        message,
        file: 'factory.yml',
        path: 'automations[0].name',
        line: 3,
        automation: 'investigate-alerts',
      },
      {
        message,
        file: 'automations/investigate-alerts.yaml',
        path: '',
        line: 1,
        automation: 'investigate-alerts',
      },
    ]);
  });

  it('counts a factory.yml entry that failed as a definition too', () => {
    const folder = ACCEPTANCE();
    folder.factoryYml =
      'version: 1\nautomations:\n  - name: investigate-alerts\n    on: { cron: "0 9 * * *" }\n    mode: sometimes\n';
    const result = parseFactory(folder);
    expect(names(result)).toEqual([]);
    expect(result.issues.filter((issue) => /defined twice/.test(issue.message))).toHaveLength(2);
  });

  it('reports strays as issues and later folders as notices', () => {
    const result = parseFactory(
      files({
        factoryYml: EMPTY_YML,
        stray: ['agents/notes.txt', 'automations/x.yml', 'skills/readme.md'],
        laterFolders: ['environments', 'evals'],
      }),
    );
    expect(result.issues).toEqual([
      {
        message: '`agents/notes.txt` is not an agent: agent files are `agents/<name>.md`.',
        file: 'agents/notes.txt',
        path: '',
      },
      {
        message:
          '`automations/x.yml` is not an automation: automation files are `automations/<name>.yaml`.',
        file: 'automations/x.yml',
        path: '',
      },
      {
        message:
          '`skills/readme.md` is not a skill: a skill is a folder, `skills/<name>/SKILL.md`.',
        file: 'skills/readme.md',
        path: '',
      },
    ]);
    expect(result.notices).toEqual([
      {
        message:
          '`environments/` is read from slice 3 (write steps); its files have no effect yet.',
      },
      { message: '`evals/` is read from slice 8 (evals); its files have no effect yet.' },
    ]);
    // Only the folders a later slice owns: any other name gets no notice.
    expect(
      parseFactory(files({ laterFolders: ['connections', 'scripts'] })).notices.map(
        (notice) => notice.message,
      ),
    ).toEqual([
      '`connections/` is read from slice 5 (connections as data); its files have no effect yet.',
    ]);
  });

  it('reports a file it could not read, as present and unreadable', () => {
    const result = parseFactory(
      files({
        factoryYml: EMPTY_YML,
        unread: [{ path: 'agents/big.md', reason: 'it is over 1 MB' }],
      }),
    );
    expect(result.issues).toEqual([
      {
        message: 'Could not read `agents/big.md`: it is over 1 MB.',
        file: 'agents/big.md',
        path: '',
      },
    ]);
    expect(result.present).toContain('agents/big.md');
    expect(result.unreadable).toEqual(['agents/big.md']);
  });

  it('says an agent it could not read has problems, not that there is none', () => {
    const folder = ACCEPTANCE();
    delete folder.agents.summariser;
    folder.unread = [{ path: 'agents/summariser.md', reason: 'EACCES: permission denied' }];
    const result = parseFactory(folder);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      '`summariser` has problems of its own in agents/summariser.md; this step runs once they are fixed.',
      'Could not read `agents/summariser.md`: EACCES: permission denied.',
    ]);
  });

  it('says a skill with a file it could not read has problems', () => {
    const folder = ACCEPTANCE();
    folder.unread = [{ path: 'skills/incident-triage/big.bin', reason: 'it is over 1 MB' }];
    const result = parseFactory(folder);
    expect(result.skills).toEqual({});
    expect(result.issues.map((issue) => issue.message)).toEqual([
      '`incident-triage` has problems of its own in skills/incident-triage/; this agent applies once they are fixed.',
      '`investigator` has problems of its own in agents/investigator.md; this step runs once they are fixed.',
      'Could not read `skills/incident-triage/big.bin`: it is over 1 MB.',
    ]);
  });

  it.each([
    ['does not parse', 'version: 1\nautomations: [\n', true],
    ['fails its envelope', 'version: 2\nautomations: []\n', true],
    [
      'has only an entry-level issue',
      'version: 1\nautomations:\n  - name: a\n    mode: sometimes\n',
      false,
    ],
  ])('lists a factory.yml that %s as unreadable: %s', (_, yml, unreadable) => {
    expect(parseFactory(files({ factoryYml: yml })).unreadable).toEqual(
      unreadable ? ['factory.yml'] : [],
    );
  });

  it('lists an automation file whose YAML does not parse as unreadable', () => {
    const result = parseFactory(files({ automations: { x: 'on: [\n' } }));
    expect(result.present).toEqual(['automations/x.yaml']);
    expect(result.unreadable).toEqual(['automations/x.yaml']);
  });

  describe('dry runs', () => {
    const notify = (agent: string) =>
      files({
        automations: {
          'investigate-alerts': INVESTIGATE_ALERTS.replace('mode: auto', 'mode: notify'),
        },
        agents: { investigator: agent, summariser: SUMMARISER },
        skills: { 'incident-triage': TRIAGE },
      });

    it('refuses a notify entry whose agent names servers, at its mode: line', () => {
      const result = parseFactory(
        notify(
          INVESTIGATOR.replace(
            'mcpServers: [claude.ai Coralogix]',
            'mcpServers: [claude.ai Slack]',
          ),
        ),
      );
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message:
            "A dry run can't keep a server's tools to reads: use `confirm`, or remove `claude.ai Slack` from `investigator`'s servers for this automation.",
          file: 'automations/investigate-alerts.yaml',
          path: 'mode',
          line: 11,
          automation: 'investigate-alerts',
        },
      ]);
    });

    it('names every server of every agent', () => {
      const result = parseFactory(
        notify(INVESTIGATOR.replace('mcpServers: [claude.ai Coralogix]', 'mcpServers: [a, b, c]')),
      );
      expect(result.issues.map((issue) => issue.message)).toEqual([
        "A dry run can't keep a server's tools to reads: use `confirm`, or remove `a` from `investigator`'s servers, `b` from `investigator`'s servers and `c` from `investigator`'s servers for this automation.",
      ]);
    });

    it('names an agent used by two steps once', () => {
      const twice = INVESTIGATE_ALERTS.replace('mode: auto', 'mode: notify').replace(
        '    agent: summariser\n',
        '    agent: investigator\n',
      );
      const result = parseFactory(
        files({
          automations: { 'investigate-alerts': twice },
          agents: { investigator: INVESTIGATOR },
          skills: { 'incident-triage': TRIAGE },
        }),
      );
      expect(result.issues.map((issue) => issue.message)).toEqual([
        "A dry run can't keep a server's tools to reads: use `confirm`, or remove `claude.ai Coralogix` from `investigator`'s servers for this automation.",
      ]);
    });

    it('takes a notify entry whose agents name skills only', () => {
      const result = parseFactory(
        notify(INVESTIGATOR.replace('mcpServers: [claude.ai Coralogix]\n', '')),
      );
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['investigate-alerts']);
    });
  });

  describe('factoryFilesOf', () => {
    it("round-trips a folder's texts to the same automations and agents", () => {
      const folder = ACCEPTANCE();
      folder.agents.investigator = INVESTIGATOR.replace('skills: [incident-triage]\n', '');
      folder.skills = {};
      const texts = {
        'factory.yml': folder.factoryYml!,
        'automations/investigate-alerts.yaml': folder.automations['investigate-alerts'],
        'agents/investigator.md': folder.agents.investigator,
        'agents/summariser.md': folder.agents.summariser,
        'skills/incident-triage/SKILL.md': 'ignored',
        'notes.txt': 'ignored',
      };
      const direct = parseFactory(folder);
      const persisted = parseFactory(factoryFilesOf(texts));
      expect(direct.issues).toEqual([]);
      expect(persisted.issues).toEqual([]);
      expect(persisted.automations).toEqual(direct.automations);
      expect(persisted.agents).toEqual(direct.agents);
    });

    it('carries no skills, so an agent that names one is then not kept', () => {
      const result = parseFactory(
        factoryFilesOf({
          'agents/investigator.md': INVESTIGATOR,
          'agents/summariser.md': SUMMARISER,
        }),
      );
      expect(Object.keys(result.agents)).toEqual(['summariser']);
      expect(result.issues.map((issue) => issue.message)).toEqual([
        '`incident-triage` is not a skill here: there is no skills/incident-triage/SKILL.md.',
      ]);
    });

    it('reads a missing factory.yml as none', () => {
      expect(factoryFilesOf({}).factoryYml).toBeNull();
      expect(factoryFilesOf({ 'factory.yml': EMPTY_YML }).factoryYml).toBe(EMPTY_YML);
    });
  });
});
