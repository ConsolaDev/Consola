import { describe, expect, it } from 'vitest';
import { factoryFilesOf, isIgnoredFileName, parseFactory, storedFactoryFiles } from './factory';
import type { FactoryFiles } from './factory';
import { parseFactorySpec } from './parse';
import { skillHash } from './skills';
import type { SkillFileEntry } from './skills';

const files = (over: Partial<FactoryFiles> = {}): FactoryFiles => ({
  factoryYml: null,
  automations: {},
  agents: {},
  skills: {},
  stray: [],
  laterFolders: [],
  unread: [],
  outside: [],
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
const TRIAGE_SKILL_MD =
  "---\nname: incident-triage\ndescription: The team's triage checklist.\n---\nCheck the alert first.\n";
const TRIAGE_QUERIES = 'Use rate() over five minutes.\n';
const TRIAGE: SkillFileEntry[] = [
  text('SKILL.md', TRIAGE_SKILL_MD),
  text('queries.md', TRIAGE_QUERIES),
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
    on: { github: { events: [pull_request.review_requested] } }
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

    it("points at a loop's step that names an agent the folder does not have", () => {
      const result = parseFactory(
        files({
          factoryYml: [
            'version: 1',
            'automations:',
            '  - name: triage',
            '    on: { cron: "0 9 * * *" }',
            '    scope: ops',
            '    steps:',
            '      - id: polish',
            '        repeat: { max: 2, until: steps.look.done }',
            '        steps:',
            '          - id: look',
            '            agent: noter',
            '            outputs: { done: { type: boolean } }',
            '',
          ].join('\n'),
        }),
      );
      expect(result.automations).toEqual([]);
      expect(result.issues).toEqual([
        {
          message: '`noter` is not an agent here: there is no agents/noter.md.',
          file: 'factory.yml',
          path: 'automations[0].steps[0].steps[0].agent',
          line: 11,
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
          // `tools: write` with no environment (slice 3-B; before it, write tools were refused outright).
          message: expect.stringMatching(/^A write agent must name its environment/),
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

  it("carries factory.yml's servers and the names of its broken ones", () => {
    const result = parseFactory(
      files({
        factoryYml: `${EMPTY_YML}mcpServers:
  slack:
    command: npx
    args: [-y, "@sprocket/slack-mcp@1.4.2"]
    secrets: [SLACK_BOT_TOKEN]
  tracker:
    url: http://mcp.tracker.sprocket.example/mcp
`,
      }),
    );
    expect(result.servers).toEqual({
      slack: {
        name: 'slack',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@sprocket/slack-mcp@1.4.2'],
        env: {},
        secrets: ['SLACK_BOT_TOKEN'],
      },
    });
    expect(result.brokenServers).toEqual(['tracker']);
    expect(result.issues).toEqual([
      {
        message: '`url` is `https://…`, or `http://` on 127.0.0.1, localhost or [::1].',
        path: 'mcpServers.tracker.url',
        line: 9,
        file: 'factory.yml',
      },
    ]);
    expect(result.notices).toEqual([]);
    // No factory.yml, no servers.
    expect(parseFactory(files())).toMatchObject({ servers: {}, brokenServers: [] });
  });

  it('gives the unpinned warning as a notice on factory.yml, at the package’s line', () => {
    const result = parseFactory(
      files({
        factoryYml: `${EMPTY_YML}mcpServers:
  slack:
    command: npx
    args:
      - -y
      - "@sprocket/slack-mcp"
`,
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.notices).toEqual([
      {
        message: 'This runs the newest version at every call, unattended; pin one.',
        file: 'factory.yml',
        line: 8,
      },
    ]);
    expect(Object.keys(result.servers)).toEqual(['slack']);
  });

  it('reports strays as issues and later folders as notices', () => {
    const result = parseFactory(
      files({
        factoryYml: EMPTY_YML,
        stray: ['agents/notes.txt', 'automations/x.yml', 'skills/readme.md'],
        // `environments/` is read since slice 3-B: no notice for it any more.
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
      { message: '`evals/` is read from slice 8 (evals); its files have no effect yet.' },
    ]);
    // Only the folders a later slice owns: any other name gets no notice.
    expect(
      parseFactory(files({ laterFolders: ['connections', 'scripts'] })).notices.map(
        (notice) => notice.message,
      ),
    ).toEqual([
      '`connections/` is read once connection manifests arrive; its files have no effect yet.',
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

  it('marks a reference to a file with problems of its own by that file, and one to a missing file by none (review M1)', () => {
    const folder = ACCEPTANCE();
    folder.agents.summariser = '---\ntools: write\n---\nYou summarise.\n';
    folder.skills['incident-triage'] = [text('SKILL.md', 'no frontmatter\n')];
    const result = parseFactory(folder);
    const causes = result.issues.map((issue) => [issue.file, issue.cause]);
    expect(causes).toEqual(
      expect.arrayContaining([
        ['agents/investigator.md', 'skills/incident-triage/'],
        ['automations/investigate-alerts.yaml', 'agents/investigator.md'],
        ['automations/investigate-alerts.yaml', 'agents/summariser.md'],
        ['agents/summariser.md', undefined],
        ['skills/incident-triage/SKILL.md', undefined],
      ]),
    );
    const missing = ACCEPTANCE();
    delete missing.agents.summariser;
    const step = parseFactory(missing).issues.find((issue) => issue.path.endsWith('agent'));
    expect(step).toMatchObject({ message: expect.stringContaining('is not an agent here') });
    expect(step).not.toHaveProperty('cause');
  });

  describe("a call's server (5a-2)", () => {
    const SLACK =
      '  slack:\n    command: npx\n    args: [-y, "@sprocket/slack-mcp@1.4.2"]\n    secrets: [SLACK_BOT_TOKEN]\n';
    const BROKEN_SLACK = '  slack:\n    command: npx\n    cwd: /Users/alice/catalog-portal\n';
    /** factory.yml with `servers` under mcpServers: (none when empty) and one entry whose steps are `steps`. */
    const yml = (servers: string, ...steps: string[]) =>
      `version: 1\n${servers ? `mcpServers:\n${servers}` : ''}automations:\n  - name: brief\n    on: { cron: "0 9 * * 1-5" }\n    scope: ops\n    steps:\n${steps
        .map((step) => `      ${step.replace(/\n/g, '\n      ')}`)
        .join('\n')}\n`;
    const POST = '- id: post\n  uses: slack#chat_post_message\n  with: { channel: C0SUPPORT1 }';

    it('applies an entry whose call names a server factory.yml defines', () => {
      const result = parseFactory(files({ factoryYml: yml(SLACK, POST) }));
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['brief']);
    });

    it("leaves out an entry whose call's server has problems of its own, pointing at the call", () => {
      const result = parseFactory(files({ factoryYml: yml(BROKEN_SLACK, POST) }));
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message: 'Consola decides where a server starts, and it is never a checkout.',
          path: 'mcpServers.slack.cwd',
          line: 5,
          file: 'factory.yml',
        },
        {
          message:
            "`slack` has problems of its own in factory.yml's `mcpServers:`; this step runs once they are fixed.",
          file: 'factory.yml',
          path: 'automations[0].steps[0].uses',
          line: 12,
          automation: 'brief',
          cause: 'factory.yml',
        },
      ]);
    });

    it('leaves out an entry whose call names a server factory.yml does not define', () => {
      const result = parseFactory(files({ factoryYml: yml('', POST) }));
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message:
            "`slack` is not a server here: factory.yml's `mcpServers:` has none of that name.",
          file: 'factory.yml',
          path: 'automations[0].steps[0].uses',
          line: 8,
          automation: 'brief',
        },
      ]);
      // A name Object.prototype has is no server either.
      const inherited = parseFactory(files({ factoryYml: yml('', '- uses: constructor#x') }));
      expect(inherited.issues.map((issue) => issue.message)).toEqual([
        "`constructor` is not a server here: factory.yml's `mcpServers:` has none of that name.",
      ]);
    });

    it("refuses a loop's call naming a server factory.yml does not define, at its line (the merge with slice 3)", () => {
      const LOOP =
        '- id: polish\n  repeat: { max: 2, until: "steps.file.key != \x27\x27" }\n  steps:\n    - id: file\n      uses: jira#create_issue\n      with: { title: Shipped }\n      outputs: { key: { type: string } }';
      const result = parseFactory(files({ factoryYml: yml(SLACK, LOOP) }));
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message:
            "`jira` is not a server here: factory.yml's `mcpServers:` has none of that name.",
          file: 'factory.yml',
          path: 'automations[0].steps[0].steps[0].uses',
          line: 16,
          automation: 'brief',
        },
      ]);
    });

    it("needs no server for Consola's own tools", () => {
      const result = parseFactory(
        files({ factoryYml: yml('', '- uses: consola#cleanup_stale_sessions') }),
      );
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['brief']);
    });

    it('checks a call in an automation file against factory.yml’s servers', () => {
      const result = parseFactory(
        files({
          factoryYml: `version: 1\nmcpServers:\n${SLACK}`,
          automations: {
            brief: `on: { cron: "0 9 * * 1-5" }\nscope: ops\nsteps:\n  - uses: slack#chat_post_message\n  - uses: tracker#create_issue\n`,
          },
        }),
      );
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message:
            "`tracker` is not a server here: factory.yml's `mcpServers:` has none of that name.",
          file: 'automations/brief.yaml',
          path: 'steps[1].uses',
          line: 5,
          automation: 'brief',
        },
      ]);
    });

    it('gives an interpreted argument fed outside text a notice at its line, and applies the entry', () => {
      const result = parseFactory(
        files({
          factoryYml: yml(
            '  tracker:\n    url: https://mcp.tracker.sprocket.example/mcp\n',
            '- id: brief\n  prompt: Brief it.',
            '- id: find\n  uses: tracker#search\n  with:\n    jql: "{{steps.brief.handover}}"\n    limit: 5',
          ),
        }),
      );
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['brief']);
      expect(result.notices).toEqual([
        {
          message:
            '`jql` gets text someone else wrote; a tool may run it as a query or open what it names. Check that this is what you mean.',
          file: 'factory.yml',
          line: 15,
        },
      ]);
    });

    it("tells an agent naming a factory server's name that it gets its harness's", () => {
      const BRIEFER =
        '---\ndescription: Briefs.\nharness: claude-work\nmcpServers: [slack]\n---\nBrief it.\n';
      const result = parseFactory(
        files({
          factoryYml: yml(SLACK, '- id: brief\n  agent: briefer', POST),
          agents: { briefer: BRIEFER },
        }),
      );
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['brief']);
      expect(Object.keys(result.agents)).toEqual(['briefer']);
      expect(result.notices).toEqual([
        {
          message:
            "`slack` is also a server in factory.yml; this agent gets `claude-work`'s `slack`, because agents use their harness's servers.",
          file: 'agents/briefer.md',
          line: 4,
        },
      ]);
      // A broken factory server's name is a factory server's name too.
      const broken = parseFactory(
        files({ factoryYml: yml(BROKEN_SLACK, '- agent: briefer'), agents: { briefer: BRIEFER } }),
      );
      expect(broken.notices.map((notice) => notice.file)).toEqual(['agents/briefer.md']);
      // No notice for a server factory.yml does not define.
      const elsewhere = parseFactory(
        files({ factoryYml: yml('', '- agent: briefer'), agents: { briefer: BRIEFER } }),
      );
      expect(elsewhere.notices).toEqual([]);
    });

    it("lets a later step read a call's outputs and its output artifact", () => {
      const result = parseFactory(
        files({
          factoryYml: yml(
            SLACK,
            '- id: post\n  uses: slack#chat_post_message\n  outputs: { ts: { type: string } }',
            '- id: follow\n  run: echo "$TS"\n  env: { TS: "{{steps.post.ts}}", BODY: "{{steps.post.output}}" }',
            '- id: tell\n  prompt: Say what was posted.\n  reads: [post.output]',
          ),
        }),
      );
      expect(result.issues).toEqual([]);
      expect(names(result)).toEqual(['brief']);
    });
  });

  describe('a file that links outside the folder (review S3)', () => {
    const OUTSIDE = (path: string) =>
      `\`${path}\` links outside the factory folder; Consola reads only files inside it.`;

    it('is an issue of its own, present and unreadable, and a step naming it waits for it', () => {
      const folder = ACCEPTANCE();
      delete folder.agents.summariser;
      folder.outside = ['agents/summariser.md'];
      const result = parseFactory(folder);
      expect(result.issues).toEqual([
        expect.objectContaining({
          message:
            '`summariser` has problems of its own in agents/summariser.md; this step runs once they are fixed.',
        }),
        { message: OUTSIDE('agents/summariser.md'), file: 'agents/summariser.md', path: '' },
      ]);
      expect(result.present).toContain('agents/summariser.md');
      expect(result.unreadable).toEqual(['agents/summariser.md']);
    });

    it('a folder that links outside covers every file in it', () => {
      const folder = ACCEPTANCE();
      folder.agents = {};
      folder.outside = ['agents/'];
      const result = parseFactory(folder);
      expect(result.issues.map((issue) => issue.message)).toEqual([
        '`investigator` has problems of its own in agents/investigator.md; this step runs once they are fixed.',
        '`summariser` has problems of its own in agents/summariser.md; this step runs once they are fixed.',
        OUTSIDE('agents/'),
      ]);
      expect(result.unreadable).toEqual(['agents/']);
    });

    it('factory.yml or an automation file outside is unreadable, so nothing in it is removed', () => {
      const result = parseFactory(
        files({ outside: ['factory.yml', 'automations/old-digest.yaml'] }),
      );
      expect(result.issues.map((issue) => issue.message)).toEqual([
        OUTSIDE('factory.yml'),
        OUTSIDE('automations/old-digest.yaml'),
      ]);
      expect(result.unreadable).toEqual(['factory.yml', 'automations/old-digest.yaml']);
    });
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

    it("names the servers of an agent only a loop's step names", () => {
      const looped = [
        'on: { cron: "0 9 * * *" }',
        'scope: ops-notes',
        'mode: notify',
        'steps:',
        '  - id: polish',
        '    repeat: { max: 2, until: steps.investigate.done }',
        '    steps:',
        '      - id: investigate',
        '        agent: investigator',
        '        outputs: { done: { type: boolean } }',
        '',
      ].join('\n');
      const result = parseFactory(
        files({
          automations: { looped },
          agents: { investigator: INVESTIGATOR },
          skills: { 'incident-triage': TRIAGE },
        }),
      );
      expect(result.issues.map((issue) => issue.message)).toEqual([
        "A dry run can't keep a server's tools to reads: use `confirm`, or remove `claude.ai Coralogix` from `investigator`'s servers for this automation.",
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

  describe('declared retries (slice 3, Call 8)', () => {
    const retrying = (agent: string, retry: number, looped = false) =>
      files({
        automations: {
          looked: [
            'on: { cron: "0 9 * * *" }',
            'scope: ops-notes',
            'steps:',
            ...(looped
              ? [
                  '  - id: polish',
                  '    repeat: { max: 2, until: steps.look.done }',
                  '    steps:',
                  '      - id: look',
                  `        agent: ${agent}`,
                  '        outputs: { done: { type: boolean } }',
                  `        on_failure: { retry: ${retry} }`,
                ]
              : ['  - id: look', `    agent: ${agent}`, `    on_failure: { retry: ${retry} }`]),
            '',
          ].join('\n'),
        },
        agents: { investigator: INVESTIGATOR, summariser: SUMMARISER },
        skills: { 'incident-triage': TRIAGE },
      });
    const NEVER =
      "`look`'s agent names an MCP server, which may post or change things, so it never retries by itself; a person retries it from the run page.";

    it('refuses a declared retry on an agent step whose agent names a server, at its on_failure', () => {
      const result = parseFactory(retrying('investigator', 1));
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        {
          message: NEVER,
          file: 'automations/looked.yaml',
          path: 'steps[0].on_failure',
          line: 6,
          automation: 'looked',
        },
      ]);
    });

    it("refuses it on a loop's step too, at the step's own line", () => {
      const result = parseFactory(retrying('investigator', 2, true));
      expect(names(result)).toEqual([]);
      expect(result.issues).toEqual([
        expect.objectContaining({ message: NEVER, path: 'steps[0].steps[0].on_failure', line: 10 }),
      ]);
    });

    it('takes a retry of 0 on it, and any retry on an agent that names no server', () => {
      expect(parseFactory(retrying('investigator', 0)).issues).toEqual([]);
      const plain = parseFactory(retrying('summariser', 3));
      expect(plain.issues).toEqual([]);
      expect(names(plain)).toEqual(['looked']);
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

    it('given no skills, carries none, so an agent that names one is then not kept', () => {
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

    it("carries a persisted version's skill files, so its agents keep the skills they name (2-C)", () => {
      const triage = [
        { path: 'SKILL.md', bytes: new TextEncoder().encode(TRIAGE_SKILL_MD) },
        { path: 'queries.md', bytes: new TextEncoder().encode(TRIAGE_QUERIES) },
      ];
      const result = parseFactory(
        factoryFilesOf(
          { 'agents/investigator.md': INVESTIGATOR, 'agents/summariser.md': SUMMARISER },
          { 'incident-triage': triage },
        ),
      );
      expect(result.issues).toEqual([]);
      expect(Object.keys(result.agents).sort()).toEqual(['investigator', 'summariser']);
      expect(result.agents.investigator.skills).toEqual(['incident-triage']);
      expect(result.skills['incident-triage'].hash).toBe(skillHash(triage));
      // The agent hashes as it does read from the folder itself, its skill's bytes included.
      expect(result.agents.investigator.hash).toBe(
        parseFactory(ACCEPTANCE()).agents.investigator.hash,
      );
    });

    it('holds its own lists of the skill files it is given', () => {
      const triage = [{ path: 'SKILL.md', bytes: new TextEncoder().encode(TRIAGE_SKILL_MD) }];
      const given = { 'incident-triage': triage };
      const carried = factoryFilesOf({}, given);
      triage.push({ path: 'late.md', bytes: new TextEncoder().encode('Added after.\n') });
      expect(carried.skills['incident-triage'].map((entry) => entry.path)).toEqual(['SKILL.md']);
      expect(factoryFilesOf({}).skills).toEqual({});
    });

    it('reads a missing factory.yml as none', () => {
      expect(factoryFilesOf({}).factoryYml).toBeNull();
      expect(factoryFilesOf({ 'factory.yml': EMPTY_YML }).factoryYml).toBe(EMPTY_YML);
    });
  });
});

describe('isIgnoredFileName (review S5)', () => {
  it.each([
    '.DS_Store',
    '.investigator.md.swp',
    '.investigator.md.swo',
    '.#investigator.md',
    'investigator.md~',
    '#investigator.md#',
    'catalog-review.yaml.orig',
    'catalog-review.yaml.rej',
    'catalog-review.yaml.bak',
    'CATALOG-REVIEW.YAML.BAK',
    'Thumbs.db',
    'desktop.ini',
  ])('passes over %s', (name) => {
    expect(isIgnoredFileName(name)).toBe(true);
  });

  it.each(['investigator.md', 'notes.txt', 'x.yml', '#', 'drafts', 'a#b.md'])(
    'reads %s, a file or a stray',
    (name) => {
      expect(isIgnoredFileName(name)).toBe(false);
    },
  );
});

describe('repos: across the folder (slice 3-B)', () => {
  const FIX = (repo: string) =>
    `  - name: fix\n    on: manual\n    mode: auto\n    checkout: { repo: ${repo}, branch: "consola/run-{{run.id}}" }\n    steps:\n      - run: "true"\n`;
  /** The same entry as a file of its own, `automations/<name>.yaml` (its name is the file's). */
  const FIX_FILE = (repo: string) =>
    `on: manual\nmode: auto\ncheckout: { repo: ${repo}, branch: "consola/run-{{run.id}}" }\nsteps:\n  - run: "true"\n`;

  it('a run-owned checkout names one of repos:', () => {
    const issues = parseFactory(
      files({
        factoryYml: `version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n${FIX('sprocket/other')}`,
      }),
    ).issues;
    expect(issues.map((i) => i.message)).toContain(
      '`sprocket/other` is not in `repos:` in factory.yml.',
    );
  });

  it('leaves the entry out, at its checkout.repo, and keeps the others', () => {
    const result = parseFactory(
      files({
        factoryYml: `version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n${FIX('sprocket/other')}  - name: ok\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n`,
      }),
    );
    expect(names(result)).toEqual(['ok']);
    expect(result.issues).toEqual([
      {
        message: '`sprocket/other` is not in `repos:` in factory.yml.',
        file: 'factory.yml',
        path: 'automations[0].checkout.repo',
        line: 7,
        automation: 'fix',
      },
    ]);
    expect(result.repos).toEqual(['sprocket/catalog-portal']);
  });

  it('keeps one that does, in factory.yml or a file of its own, case aside', () => {
    const result = parseFactory(
      files({
        factoryYml: `version: 1\nrepos: [Sprocket/Catalog-Portal]\nautomations:\n${FIX('sprocket/catalog-portal')}`,
        automations: { other: FIX_FILE('SPROCKET/catalog-portal') },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(names(result)).toEqual(['fix', 'other']);
  });

  it('refuses an automation file whose checkout names a repository with no factory.yml to list it', () => {
    const result = parseFactory(
      files({
        automations: { fix: FIX_FILE('sprocket/catalog-portal') },
      }),
    );
    expect(names(result)).toEqual([]);
    expect(result.issues.map((i) => i.message)).toEqual([
      '`sprocket/catalog-portal` is not in `repos:` in factory.yml.',
    ]);
    expect(result.repos).toEqual([]);
  });
});

describe('environments/ (slice 3-B)', () => {
  const EMPTY_FILES = files({ factoryYml: EMPTY_YML });

  it('environments/ is read: no notice, its strays reported, its files parsed', () => {
    const parsed = parseFactory({
      ...EMPTY_FILES,
      environments: { sandboxed: 'isolation: sandbox\n' },
      stray: ['environments/x.yml'],
    });
    expect(parsed.environments.sandboxed.isolation).toBe('sandbox');
    expect(parsed.notices.map((n) => n.message).join()).not.toContain('environments/');
    expect(parsed.issues.map((i) => i.message)).toContain(
      '`environments/x.yml` is not an environment: environment files are `environments/<name>.yaml`.',
    );
  });

  it('names each file present, keeps only the valid ones, and says what is wrong in each', () => {
    const parsed = parseFactory({
      ...EMPTY_FILES,
      environments: {
        sandboxed: 'isolation: sandbox\nenv: [CI]\n',
        broken: 'isolation: host\nenv: [CI]\n',
      },
    });
    expect(Object.keys(parsed.environments)).toEqual(['sandboxed']);
    expect(parsed.environments.sandboxed).toMatchObject({ name: 'sandboxed', env: ['CI'] });
    expect(parsed.present).toEqual(
      expect.arrayContaining(['environments/broken.yaml', 'environments/sandboxed.yaml']),
    );
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        file: 'environments/broken.yaml',
        path: 'env',
        message: expect.stringContaining('On `host` a step has your whole network'),
      }),
    ]);
  });

  it('reads none when the adapter gives none (every slice-1 and 2 caller)', () => {
    const parsed = parseFactory(EMPTY_FILES);
    expect(parsed.environments).toEqual({});
    expect(parsed.issues).toEqual([]);
  });

  it('factoryFilesOf reads environments/<n>.yaml back, and nothing else under environments/', () => {
    const read = factoryFilesOf({
      'factory.yml': EMPTY_YML,
      'environments/sandboxed.yaml': 'isolation: sandbox\n',
      'environments/x.yml': 'isolation: host\n',
    });
    expect(read.environments).toEqual({ sandboxed: 'isolation: sandbox\n' });
  });
});

describe('write agents across the folder (slice 3-B)', () => {
  const WRITE_AGENT =
    '---\nharness: claude-work\ntools: write\nenvironment: sandboxed\n---\nFix it.\n';
  const OWNED = (steps: string) =>
    `version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n  - name: fix\n    on: manual\n    checkout: { repo: sprocket/catalog-portal, branch: "consola/run-{{run.id}}" }\n    steps:\n${steps}`;
  const FIX_STEP = '      - id: fix\n        agent: fixer\n        prompt: Fix.\n';

  it('an environment that is not there keeps the agent out, at its environment line', () => {
    const parsed = parseFactory(files({ agents: { fixer: WRITE_AGENT } }));
    expect(parsed.agents.fixer).toBeUndefined();
    expect(parsed.issues).toEqual([
      {
        message: '`sandboxed` is not an environment here: there is no environments/sandboxed.yaml.',
        file: 'agents/fixer.md',
        path: 'environment',
        line: 4,
      },
    ]);
  });

  it('one with problems of its own keeps the agent out too, naming its file', () => {
    const parsed = parseFactory(
      files({ agents: { fixer: WRITE_AGENT }, environments: { sandboxed: 'isolation: vm\n' } }),
    );
    expect(parsed.agents.fixer).toBeUndefined();
    expect(parsed.issues).toContainEqual({
      message:
        '`sandboxed` has problems of its own in environments/sandboxed.yaml; this agent applies once they are fixed.',
      file: 'agents/fixer.md',
      path: 'environment',
      line: 4,
      cause: 'environments/sandboxed.yaml',
    });
  });

  it('keeps a write agent whose environment is valid', () => {
    const parsed = parseFactory(
      files({
        agents: { fixer: WRITE_AGENT },
        environments: { sandboxed: 'isolation: sandbox\n' },
      }),
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.agents.fixer).toMatchObject({ tools: 'write', environment: 'sandboxed' });
  });

  it('a write agent needs a run-owned checkout, at its step', () => {
    const parsed = parseFactory(
      files({
        agents: { fixer: WRITE_AGENT },
        environments: { sandboxed: 'isolation: sandbox\n' },
        factoryYml:
          'version: 1\nautomations:\n  - name: fix\n    on: manual\n    scope: app\n    steps:\n      - agent: fixer\n        prompt: Fix.\n',
      }),
    );
    expect(names(parsed)).toEqual([]);
    expect(parsed.issues).toEqual([
      {
        message:
          'A write agent changes code only on a branch the run cuts from one of `repos:` (invariant 9). Add `checkout: { repo: …, branch: … }`.',
        file: 'factory.yml',
        path: 'automations[0].steps[0].agent',
        line: 7,
        automation: 'fix',
      },
    ]);
  });

  it("an item checkout is not one the run owns: a loop's write agent is refused there too", () => {
    const parsed = parseFactory(
      files({
        agents: { fixer: WRITE_AGENT.replace('tools: write', 'tools: edit') },
        environments: { sandboxed: 'isolation: sandbox\n' },
        factoryYml:
          'version: 1\nautomations:\n  - name: fix\n    on: { github: { events: [pull_request.opened] } }\n    checkout: { pr: item }\n    steps:\n      - id: polish\n        repeat: { max: 2, until: steps.fix.done }\n        steps:\n          - id: fix\n            agent: fixer\n            prompt: Fix.\n            outputs: { done: { type: boolean } }\n',
      }),
    );
    expect(names(parsed)).toEqual([]);
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('A write agent changes code only on a branch'),
        path: 'automations[0].steps[0].steps[0].agent',
      }),
    ]);
  });

  it('a write agent on host never retries by itself; one in a sandbox, or an edit agent on host, may', () => {
    const entry = (env: string, tools = 'write') =>
      parseFactory(
        files({
          agents: {
            fixer: WRITE_AGENT.replace('sandboxed', env).replace('tools: write', `tools: ${tools}`),
          },
          environments: { [env]: env === 'mine' ? 'isolation: host\n' : 'isolation: sandbox\n' },
          factoryYml: OWNED(`${FIX_STEP}        on_failure: { retry: 1 }\n`),
        }),
      );
    const host = entry('mine');
    expect(names(host)).toEqual([]);
    expect(host.issues).toEqual([
      {
        message:
          "`fix`'s agent writes and runs commands on `host`, so it never retries by itself; a person retries it from the run page.",
        file: 'factory.yml',
        path: 'automations[0].steps[0].on_failure',
        line: 11,
        automation: 'fix',
      },
    ]);
    expect(entry('sandboxed').issues).toEqual([]);
    expect(names(entry('sandboxed'))).toEqual(['fix']);
    expect(entry('mine', 'edit').issues).toEqual([]);
    // A retry of 0 is no retry.
    expect(
      parseFactory(
        files({
          agents: { fixer: WRITE_AGENT.replace('sandboxed', 'mine') },
          environments: { mine: 'isolation: host\n' },
          factoryYml: OWNED(`${FIX_STEP}        on_failure: { retry: 0 }\n`),
        }),
      ).issues,
    ).toEqual([]);
  });

  it('a read-only agent in a run-owned entry is kept as before', () => {
    const parsed = parseFactory(
      files({
        agents: { reader: '---\nharness: claude-work\n---\nRead it.\n' },
        factoryYml: OWNED(
          '      - id: look\n        agent: reader\n        on_failure: { retry: 2 }\n',
        ),
      }),
    );
    expect(parsed.issues).toEqual([]);
    expect(names(parsed)).toEqual(['fix']);
  });
});

describe('path artifacts across the folder (slice 3-B)', () => {
  const OWNED = (step: string) =>
    `version: 1\nrepos: [sprocket/catalog-portal]\nautomations:\n  - name: fix\n    on: manual\n    checkout: { repo: sprocket/catalog-portal, branch: "consola/run-{{run.id}}" }\n    steps:\n${step}`;
  const PATH_STEP = (agent: string) =>
    `      - id: fix\n${agent}        prompt: Fix.\n        artifacts: [notes, { name: spec, path: docs/a.md }]\n`;
  const NEEDS =
    'A read-only agent writes no files; `spec` with a `path:` needs an `edit` or `write` agent.';
  const folder = (yml: string) =>
    files({
      factoryYml: yml,
      agents: {
        reader: '---\nharness: claude-work\n---\nRead it.\n',
        fixer: '---\nharness: claude-work\ntools: edit\nenvironment: sandboxed\n---\nFix it.\n',
      },
      environments: { sandboxed: 'isolation: sandbox\n' },
    });

  it('a path artifact needs an agent that writes, at its artifacts', () => {
    const result = parseFactory(folder(OWNED(PATH_STEP('        agent: reader\n'))));
    expect(names(result)).toEqual([]);
    expect(result.issues).toEqual([
      {
        message: NEEDS,
        file: 'factory.yml',
        path: 'automations[0].steps[0].artifacts',
        line: 11,
        automation: 'fix',
      },
    ]);
  });

  it('a step on the default harness is read-only too', () => {
    expect(parseFactory(folder(OWNED(PATH_STEP('')))).issues.map((i) => i.message)).toEqual([
      NEEDS,
    ]);
  });

  it('an edit or write agent may write one', () => {
    const result = parseFactory(folder(OWNED(PATH_STEP('        agent: fixer\n'))));
    expect(result.issues).toEqual([]);
    expect(names(result)).toEqual(['fix']);
  });
});

describe('storedFactoryFiles', () => {
  it('puts each stored file where the folder’s reader would', () => {
    const files = storedFactoryFiles([
      { path: 'factory.yml', content: 'automations: []\n' },
      { path: 'automations/triage.yaml', content: 'name: triage\n' },
      { path: 'agents/reviewer.md', content: '---\ndescription: Reviews\n---\nBody\n' },
      { path: 'skills/release/SKILL.md', content: 'skill' },
      { path: 'skills/release/notes/one.md', content: 'one' },
      { path: 'evals/smoke.yaml', content: 'later' },
      { path: 'README.md', content: 'stray' },
    ]);
    expect(files.factoryYml).toBe('automations: []\n');
    expect(files.automations).toEqual({ triage: 'name: triage\n' });
    expect(files.agents).toEqual({ reviewer: '---\ndescription: Reviews\n---\nBody\n' });
    expect(Object.keys(files.skills)).toEqual(['release']);
    expect(files.skills.release.map((entry) => entry.path)).toEqual(['SKILL.md', 'notes/one.md']);
    expect(files.laterFolders).toEqual(['evals']);
    expect(files.stray).toEqual(['README.md']);
  });

  it('keeps a name such as __proto__ as a key like any other', () => {
    const files = storedFactoryFiles([{ path: 'agents/__proto__.md', content: 'x' }]);
    expect(Object.keys(files.agents)).toEqual(['__proto__']);
  });

  it('reads no files as a blank factory', () => {
    expect(parseFactory(storedFactoryFiles([])).issues).toEqual([]);
  });
});
