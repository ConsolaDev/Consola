import { describe, expect, it } from 'vitest';
import { parseFactory, storedFactoryFiles } from './factory';
import { parseFactorySpec } from './parse';

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) =>
  parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const REVIEW = '    on: { github: { events: [pull_request.review_requested] } }\n';
const DAILY = '    on: { cron: "0 9 * * 1-5" }\n';

describe('run:', () => {
  it('runs an action', () => {
    const result = one(`${REVIEW}    run: { action: Review }\n    mode: auto\n`);
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({
      trigger: {
        kind: 'event',
        connection: 'github',
        events: ['pull_request.review_requested'],
      },
      run: { kind: 'action', ref: 'Review', name: 'Review' },
      mode: 'auto',
    });
  });

  it('runs a prompt written in the automation, in a scope', () => {
    const result = one(
      `${DAILY}    run:\n      prompt: |\n        List my open pull requests.\n    scope: api\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({
      trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
      run: { kind: 'prompt', ref: 'prompt', prompt: 'List my open pull requests.\n' },
      scope: 'api',
    });
  });

  it('runs a tool with its arguments under run', () => {
    const result = one(
      `${DAILY}    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged] } }\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0].run).toEqual({
      kind: 'tool',
      ref: 'consola#cleanup_stale_sessions',
      namespace: 'consola',
      tool: 'cleanup_stale_sessions',
      with: { pr_states: ['merged'] },
    });
  });

  it('rejects the string form, showing the object form to write', () => {
    const tool = one(`${DAILY}    run: consola#cleanup_stale_sessions\n`);
    expect(tool.automations).toEqual([]);
    expect(tool.issues[0]).toMatchObject({ path: 'automations[0].run', line: 5 });
    expect(tool.issues[0].message).toContain('run: { tool: consola#cleanup_stale_sessions }');

    const action = one(`${REVIEW}    run: Review\n`);
    expect(action.issues[0].message).toContain('run: { action: Review }');
  });

  it('reports the old run-plus-with pair once, with the whole line to write', () => {
    const result = one(
      `${DAILY}    run: consola#cleanup_stale_sessions\n    with: { pr_states: [merged, closed] }\n`,
    );
    expect(result.automations).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ path: 'automations[0].run', line: 5 });
    expect(result.issues[0].message).toContain(
      'run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [ merged, closed ] } }',
    );
  });

  it('rejects a top-level with, saying it moved under run', () => {
    const result = one(`${DAILY}    run: { tool: consola#x }\n    with: { a: 1 }\n`);
    expect(result.automations).toEqual([]);
    expect(result.issues[0]).toMatchObject({ path: 'automations[0].with' });
    expect(result.issues[0].message).toMatch(/under `run:`/);
  });

  it('takes with only under a tool', () => {
    const result = one(`${REVIEW}    run: { action: Review, with: { a: 1 } }\n`);
    expect(result.issues[0]).toMatchObject({
      path: 'automations[0].run.with',
      message: 'Only a tool takes `with:`.',
    });
  });

  it('names exactly one thing to run', () => {
    expect(one(`${REVIEW}    run: { action: Review, prompt: hi }\n`).issues[0].message).toMatch(
      /one thing to run/,
    );
    expect(one(`${REVIEW}    run: {}\n`).issues[0].message).toMatch(
      /one of `action`, `prompt` or `tool`/,
    );
    expect(one(`${REVIEW}    run: { agent: Review }\n`).issues[0]).toMatchObject({
      path: 'automations[0].run.agent',
    });
  });

  it('rejects malformed tool references and empty bodies', () => {
    expect(one(`${DAILY}    run: { tool: "consola#Bad-Tool" }\n`).issues[0].message).toMatch(
      /not a tool reference/,
    );
    expect(one(`${REVIEW}    run: { action: "  " }\n`).issues[0].path).toBe(
      'automations[0].run.action',
    );
    expect(one(`${DAILY}    run: { prompt: "" }\n    scope: api\n`).issues[0].path).toBe(
      'automations[0].run.prompt',
    );
  });
});

describe('on:', () => {
  /** One entry triggered by `on`, written as given, running a prompt. */
  const on = (trigger: string, rest = '') =>
    one(`    on: ${trigger}\n    run: { action: Review }\n${rest}`);
  const issues = (result: ReturnType<typeof one>) =>
    result.issues.map((issue) => [issue.path, issue.message]);

  it('reads a connection as its events and its filter, the filter present only when written', () => {
    expect(
      on('{ github: { events: [pull_request.review_requested] } }').automations[0].trigger,
    ).toEqual({
      kind: 'event',
      connection: 'github',
      events: ['pull_request.review_requested'],
    });
    const filtered = on(
      '{ github: { events: [pull_request.review_requested, pull_request.assigned], filter: { repos: ["acme/*"], authors_not: ["dependabot[bot]"] } } }',
    );
    expect(filtered.issues).toEqual([]);
    expect(filtered.automations[0].trigger).toEqual({
      kind: 'event',
      connection: 'github',
      events: ['pull_request.review_requested', 'pull_request.assigned'],
      filter: { repos: ['acme/*'], authors_not: ['dependabot[bot]'] },
    });
    // An undotted event name is still an event name, and any connection's filter is the runner's to read.
    expect(
      one(
        '    on: { slack: { events: [mention], filter: { channel: "#bugs" } } }\n    run: { prompt: hi }\n    scope: api\n',
      ).issues,
    ).toEqual([]);
  });

  it('reads the block layout the files Consola writes use', () => {
    const result = one(
      [
        '    on:',
        '      github:',
        '        events:',
        '          - pull_request.opened',
        '          - pull_request.synchronize',
        '        filter:',
        '          repos:',
        '            - sprocket/catalog-portal',
        '          authors_not:',
        '            - dependabot[bot]',
        '          drafts: false',
        '    run: { action: Review }',
        '',
      ].join('\n'),
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0].trigger).toEqual({
      kind: 'event',
      connection: 'github',
      events: ['pull_request.opened', 'pull_request.synchronize'],
      filter: {
        repos: ['sprocket/catalog-portal'],
        authors_not: ['dependabot[bot]'],
        drafts: false,
      },
    });
  });

  it('refuses events written as one name or a bare list, showing the one form', () => {
    expect(issues(on('{ github: pull_request.review_requested }'))).toEqual([
      [
        'automations[0].on.github',
        "A connection's events are a list under `events:`: write `on: { github: { events: [ pull_request.review_requested ] } }`.",
      ],
    ]);
    expect(
      issues(on('{ github: [pull_request.review_requested, pull_request.assigned] }')),
    ).toEqual([
      [
        'automations[0].on.github',
        "A connection's events are a list under `events:`: write `on: { github: { events: [ pull_request.review_requested, pull_request.assigned ] } }`.",
      ],
    ]);
    expect(issues(on('{ github: { events: pull_request.assigned } }'))).toEqual([
      [
        'automations[0].on.github.events',
        '`events` is a list, even of one event: write `events: [pull_request.assigned]`.',
      ],
    ]);
  });

  it('holds exactly one trigger: a key beside it is refused, saying where a filter goes', () => {
    expect(
      issues(on('{ github: pull_request.review_requested, filter: { authors_not: [bob] } }')),
    ).toEqual([
      [
        'automations[0].on.filter',
        '`filter:` goes under `github:`, beside `events:`: write `on: { github: { events: [ pull_request.review_requested ], filter: { authors_not: [ bob ] } } }`.',
      ],
      [
        'automations[0].on.github',
        "A connection's events are a list under `events:`: write `on: { github: { events: [ pull_request.review_requested ] } }`.",
      ],
    ]);
    // What was an event's parameter: a key beside the trigger, whatever it looks like.
    expect(issues(on('{ jira: { events: [issue.transitioned] }, to: "Ready for dev" }'))).toEqual([
      [
        'automations[0].on.to',
        '`on` holds one trigger, `jira`, and `to` cannot sit beside it: a connection takes `events:` and `filter:`, under its name, e.g. `on: { jira: { events: [ issue.transitioned ] } }`.',
      ],
    ]);
    expect(
      issues(one('    on: { cron: "0 9 * * *", tz: UTC }\n    run: { tool: consola#x }\n')),
    ).toEqual([['automations[0].on.tz', '`on` holds one trigger, `cron`; remove `tz`.']]);
  });

  it('takes only events and filter under a connection', () => {
    expect(issues(on('{ github: { events: [pull_request.opened], to: main } }'))).toEqual([
      [
        'automations[0].on.github.to',
        'Unrecognized key in `github`: to. A connection takes `events` and `filter`.',
      ],
    ]);
    expect(issues(on('{ github: { filter: { repos: [acme/api] } } }'))).toEqual([
      [
        'automations[0].on.github',
        'Say which events fire it, as a list under `events:`, e.g. `on: { github: { events: [ pull_request.opened ], filter: { repos: [ acme/api ] } } }`.',
      ],
    ]);
    expect(issues(on('{ github: }'))).toEqual([
      [
        'automations[0].on.github',
        'Expected `github:` to hold `events:`, a list, and `filter:` if it needs one, e.g. `on: { github: { events: [ pull_request.opened ] } }`.',
      ],
    ]);
  });

  it('refuses a filter that is not a mapping of fields, or names none', () => {
    expect(issues(on('{ github: { events: [pull_request.opened], filter: [acme/api] } }'))).toEqual(
      [
        [
          'automations[0].on.github.filter',
          "Expected `filter` to be a mapping of the connection's fields, e.g. `filter: { repos: [sprocket/catalog-portal] }`.",
        ],
      ],
    );
    expect(issues(on('{ github: { events: [pull_request.opened], filter: {} } }'))).toEqual([
      [
        'automations[0].on.github.filter',
        'A filter names at least one field; leave `filter:` out to let every item fire.',
      ],
    ]);
  });

  it('rejects names that are not a connection id or an event name', () => {
    expect(on('{ GitHub: { events: [pull_request.review_requested] } }').issues[0].message).toMatch(
      /not a trigger/,
    );
    expect(on('{ github: { events: [Pull Request] } }').issues[0]).toMatchObject({
      path: 'automations[0].on.github.events[0]',
      message: 'Expected an event name, lowercase and dotted, e.g. pull_request.review_requested.',
    });
    expect(on('{}').issues[0].message).toMatch(/Expected a trigger/);
  });

  it("takes a pull request's webhook events, one or all three, as any event: which runner fires one is the runner's", () => {
    const events = ['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'];
    const fileOn = (written: string) =>
      parseFactory(
        storedFactoryFiles([
          { path: 'factory.yml', content: 'version: 1\n' },
          {
            path: 'automations/review.yaml',
            content: `on: ${written}\nsteps:\n  - prompt: Review it.\n`,
          },
        ]),
      );
    for (const event of events) {
      const read = fileOn(`{ github: { events: [${event}] } }`);
      expect([event, read.issues, read.notices]).toEqual([event, [], []]);
      expect(read.automations[0].trigger).toEqual({
        kind: 'event',
        connection: 'github',
        events: [event],
      });
    }
    const all = fileOn(`{ github: { events: [${events.join(', ')}] } }`);
    expect(all.issues).toEqual([]);
    expect(all.automations[0].trigger).toEqual({ kind: 'event', connection: 'github', events });
  });

  it('rejects an empty or repeating list, each at its place', () => {
    expect(issues(on('{ github: { events: [] } }'))).toEqual([
      ['automations[0].on.github.events', 'List at least one event under `events:`.'],
    ]);
    expect(
      issues(on('{ github: { events: [pull_request.assigned, pull_request.assigned] } }')),
    ).toEqual([['automations[0].on.github.events[1]', '`pull_request.assigned` is listed twice.']]);
  });
});

describe('filter and scope', () => {
  it('refuses a filter on the entry, showing where it goes under its connection', () => {
    const old = one(
      '    on: { github: [pull_request.review_requested, pull_request.assigned] }\n    filter: { authors_not: ["dependabot[bot]"] }\n    run: { action: Review }\n',
    );
    expect(old.automations).toEqual([]);
    expect(old.issues.map((issue) => [issue.path, issue.message])).toContainEqual([
      'automations[0].filter',
      '`filter:` goes under `github:` in `on:`, beside `events:`: write `on: { github: { events: [ pull_request.review_requested, pull_request.assigned ], filter: { authors_not: [ "dependabot[bot]" ] } } }`.',
    ]);
    // Beside a trigger already in its one form, the line keeps its events.
    expect(
      one(`${REVIEW}    filter: { repos: ["acme/*"] }\n    run: { action: Review }\n`).issues,
    ).toEqual([
      expect.objectContaining({
        path: 'automations[0].filter',
        message:
          '`filter:` goes under `github:` in `on:`, beside `events:`: write `on: { github: { events: [ pull_request.review_requested ], filter: { repos: [ acme/* ] } } }`.',
      }),
    ]);
  });

  it('rejects a filter on a schedule', () => {
    const result = one(
      `${DAILY}    filter: { repos: ["acme/*"] }\n    run: { prompt: hi }\n    scope: api\n`,
    );
    expect(result.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [
        'automations[0].filter',
        '`filter` narrows which items fire an event; a schedule has no items.',
      ],
    ]);
  });

  it('requires a scope for a scheduled prompt, and refuses an action on a schedule', () => {
    expect(one(`${DAILY}    run: { prompt: hi }\n`).issues[0]).toMatchObject({
      path: 'automations[0].scope',
    });
    expect(one(`${DAILY}    run: { action: Review }\n    scope: api\n`).issues[0].message).toMatch(
      /schedule has no item/,
    );
  });

  it('refuses a scope on a tool run', () => {
    expect(one(`${DAILY}    run: { tool: consola#x }\n    scope: api\n`).issues[0]).toMatchObject({
      path: 'automations[0].scope',
    });
  });
});
