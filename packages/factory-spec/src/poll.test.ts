import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';
import { secretTemplateReason } from './secrets';

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) =>
  parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const RUN = '    run: { prompt: "Look." }\n';
const POLL_BASE = 'every: 30m, run: "gh api x", key: .id';
const poll = (body: string, rest = RUN + '    scope: api\n') =>
  one(`    on: { poll: { ${body} } }\n${rest}`);
const issues = (result: ReturnType<typeof one>) =>
  result.issues.map((issue) => [issue.path, issue.message]);

const FIELD_PATH =
  'Write a field path as `.name` or `.name.name`, e.g. `.head`: names are letters, digits and _, and a path walks objects only.';
const NO_ITEM_SCOPE =
  'Say where this runs: `scope: <one of the workspace’s scopes>`. This automation has no item to run on.';

describe('on: poll', () => {
  it("parses the template's poll", () => {
    const result = one(
      `    on:\n      poll:\n        every: 30m\n        run: gh api graphql\n        item: { github: .url }\n        changed: .head\n    mode: auto\n    steps:\n      - id: s\n        run: echo\n`,
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0].trigger).toEqual({
      kind: 'poll',
      run: 'gh api graphql',
      everyMs: 1_800_000,
      timeoutMs: 60_000,
      item: { connection: 'github', path: '.url' },
      changed: '.head',
    });
  });

  it('takes a key instead of an item', () => {
    const result = poll('every: 30m, run: x, key: .id, changed: .head');
    expect(result.issues).toEqual([]);
    expect(result.automations[0].trigger).toEqual({
      kind: 'poll',
      run: 'x',
      everyMs: 1_800_000,
      timeoutMs: 60_000,
      key: '.id',
      changed: '.head',
    });
  });

  it('reads every as minutes or hours, 1m to 24h', () => {
    const everyMs = (every: string) =>
      (poll(`every: ${every}, run: x, key: .id`).automations[0]?.trigger as { everyMs: number })
        ?.everyMs;
    expect(everyMs('1m')).toBe(60_000);
    expect(everyMs('24h')).toBe(86_400_000);
    for (const bad of ['30s', '0m', '25h', '1441m']) {
      expect(issues(poll(`every: ${bad}, run: x, key: .id`))).toEqual([
        ['automations[0].on.poll.every', '`every` is `<n>m` or `<n>h`, from 1m to 24h.'],
      ]);
    }
    expect(issues(poll('run: x, key: .id'))).toEqual([
      ['automations[0].on.poll.every', 'Say how often to check, e.g. `every: 30m`.'],
    ]);
  });

  it('reads timeout up to 5m', () => {
    const timeoutMs = (timeout: string) =>
      (poll(`${POLL_BASE}, timeout: ${timeout}`).automations[0]?.trigger as { timeoutMs: number })
        ?.timeoutMs;
    expect(timeoutMs('30s')).toBe(30_000);
    expect(timeoutMs('5m')).toBe(300_000);
    expect(issues(poll(`${POLL_BASE}, timeout: 6m`))).toEqual([
      ['automations[0].on.poll.timeout', 'A check times out after at most 5m.'],
    ]);
    expect(issues(poll(`${POLL_BASE}, timeout: 0s`))).toEqual([
      ['automations[0].on.poll.timeout', 'A timeout is at least 1s.'],
    ]);
    expect(issues(poll(`${POLL_BASE}, timeout: 2`))).toEqual([
      [
        'automations[0].on.poll.timeout',
        'Write the timeout as `<n>s`, `<n>m` or `<n>h`, e.g. `10m`.',
      ],
    ]);
  });

  it('needs a command, and takes no placeholders in it', () => {
    const say =
      'Say what to run, e.g. `run: gh api graphql …`: its stdout is a JSON array of objects, one per item.';
    expect(issues(poll('every: 30m, key: .id'))).toEqual([['automations[0].on.poll.run', say]]);
    expect(issues(poll('every: 30m, run: "", key: .id'))).toEqual([
      ['automations[0].on.poll.run', say],
    ]);
    expect(issues(poll('every: 30m, run: "echo {{item.url}}", key: .id'))).toEqual([
      [
        'automations[0].on.poll.run',
        'A check command takes no `{{ }}`: it runs before there is an item, and values reach commands only as environment variables.',
      ],
    ]);
  });

  it('has one identity per item, written as a field path', () => {
    expect(issues(poll('every: 30m, run: x, key: .id, item: { github: .url }'))).toEqual([
      ['automations[0].on.poll', 'A poll item has one identity: `key:` or `item:`, not both.'],
    ]);
    expect(issues(poll('every: 30m, run: x'))).toEqual([
      [
        'automations[0].on.poll',
        'Say what identifies an item: `key: .id`, or `item: { github: .url }`.',
      ],
    ]);
    expect(issues(poll('every: 30m, run: x, key: id, changed: head'))).toEqual([
      ['automations[0].on.poll.key', FIELD_PATH],
      ['automations[0].on.poll.changed', FIELD_PATH],
    ]);
    expect(issues(poll('every: 30m, run: x, item: { github: url }'))).toEqual([
      ['automations[0].on.poll.item.github', FIELD_PATH],
    ]);
    expect(issues(poll('every: 30m, run: x, item: { github: .url, jira: .key }'))).toEqual([
      ['automations[0].on.poll.item', '`item:` names one connection, e.g. `{ github: .url }`.'],
    ]);
    const bad = poll('every: 30m, run: x, item: { Git: .url }');
    expect(bad.issues[0].path).toBe('automations[0].on.poll.item.Git');
    expect(bad.issues[0].message).toContain('"Git" is not a trigger.');
  });

  it('refuses unknown keys, and a key beside poll', () => {
    expect(issues(poll('every: 30m, run: x, key: .id, filter: y'))).toEqual([
      [
        'automations[0].on.poll.filter',
        'Unrecognized key in `poll`: filter. Expected run, every, key, item, changed, timeout or secrets.',
      ],
    ]);
    expect(
      issues(one(`    on: { poll: { ${POLL_BASE} }, extra: 1 }\n${RUN}    scope: api\n`)),
    ).toEqual([['automations[0].on.extra', '`on` holds one trigger, `poll`; remove `extra`.']]);
  });

  it('names the secrets its check command needs', () => {
    const named = poll('run: x, every: 5m, key: .id, secrets: [TRACKER_TOKEN]');
    expect(named.issues).toEqual([]);
    expect(named.automations[0].trigger).toMatchObject({
      kind: 'poll',
      secrets: ['TRACKER_TOKEN'],
    });
    expect('secrets' in poll(POLL_BASE).automations[0].trigger).toBe(false);
    expect('secrets' in poll(`${POLL_BASE}, secrets: []`).automations[0].trigger).toBe(false);
  });

  it("refuses a check's secret as a step's", () => {
    expect(issues(poll(`${POLL_BASE}, secrets: [GH_TOKEN]`))).toEqual([
      [
        'automations[0].on.poll.secrets[0]',
        "Commands act as the workspace's bound GitHub account, whose token Consola puts in `GH_TOKEN` (decision 37). To act as another account, bind it to the workspace.",
      ],
    ]);
    expect(issues(poll(`${POLL_BASE}, secrets: x`))).toEqual([
      [
        'automations[0].on.poll.secrets',
        'Expected `secrets` to be a list of names, e.g. `secrets: [PAGERDUTY_TOKEN]`.',
      ],
    ]);
  });

  it.each(['uses', 'with', 'items'])('refuses %s until polls by MCP tool', (key) => {
    expect(issues(poll(`${POLL_BASE}, ${key}: x`))).toEqual([
      [
        `automations[0].on.poll.${key}`,
        `\`${key}\` in a poll arrives with polls by MCP tool; it is not supported yet.`,
      ],
    ]);
  });

  it('refuses an unknown key beside one that arrives later, each with its reason', () => {
    expect(issues(poll(`${POLL_BASE}, uses: x, foo: 1`))).toEqual([
      [
        'automations[0].on.poll.uses',
        '`uses` in a poll arrives with polls by MCP tool; it is not supported yet.',
      ],
      [
        'automations[0].on.poll.foo',
        'Unrecognized key in `poll`: foo. Expected run, every, key, item, changed, timeout or secrets.',
      ],
    ]);
  });

  it('says how a secret reaches a check command', () => {
    expect(issues(poll('every: 30m, run: "echo {{secrets.TRACKER_TOKEN}}", key: .id'))).toEqual([
      ['automations[0].on.poll.run', secretTemplateReason('TRACKER_TOKEN')],
    ]);
  });

  it('refuses filter: on a poll, saying where it goes', () => {
    const result = poll(POLL_BASE, `${RUN}    scope: api\n    filter: { repos: [x] }\n`);
    expect(issues(result)).toEqual([
      ['automations[0].filter', 'Filter in the command, for example with `--jq`.'],
    ]);
  });
});

describe('on: manual', () => {
  it('is the word alone: any mapping under manual is refused, showing the one form', () => {
    const result = one('    on: manual\n    run: { tool: consola#list_sessions }\n');
    expect(result.issues).toEqual([]);
    expect(result.automations[0].trigger).toEqual({ kind: 'manual' });
    for (const on of ['{ manual: {} }', '{ manual: null }', '{ manual: { x: 1 } }']) {
      expect(issues(one(`    on: ${on}\n    run: { tool: consola#list_sessions }\n`)), on).toEqual([
        [
          'automations[0].on.manual',
          'A run on demand is the word alone: write `on: manual`, with nothing under it.',
        ],
      ]);
    }
  });

  it('refuses the triggers later slices bring, and bare words that are not one', () => {
    expect(issues(one(`    on: { webhook: {} }\n${RUN}`))).toEqual([
      [
        'automations[0].on.webhook',
        '`webhook` arrives with the headless runner; it is not supported yet.',
      ],
    ]);
    expect(issues(one(`    on: { consola: run.finished }\n${RUN}`))).toEqual([
      [
        'automations[0].on.consola',
        '`consola` arrives with connections as data; it is not supported yet.',
      ],
    ]);
    const bare = one(`    on: cron\n${RUN}`);
    expect(bare.issues[0].path).toBe('automations[0].on');
    expect(bare.issues[0].message).toMatch(
      /^Expected a trigger, .*cron.*poll.*`on: manual`.*github/,
    );
  });

  it('reads a name every object inherits as any other name, never as a later trigger', () => {
    // A lowercase id, so a connection's name, as `gitlab` is: the runner says there is no such connection.
    expect(one(`    on: { constructor: { events: [x] } }\n${RUN}`)).toMatchObject({
      issues: [],
      automations: [{ trigger: { kind: 'event', connection: 'constructor', events: ['x'] } }],
    });
    // Not an id: refused with the sentence any such word gets.
    expect(issues(one(`    on: { toString: x }\n${RUN}`))).toEqual([
      ['automations[0].on.toString', expect.stringMatching(/^"toString" is not a trigger\. /)],
    ]);
  });
});

describe('applies_to:', () => {
  const manual = (appliesTo: string, rest = '    run: { action: Review }\n') =>
    one(`    on: manual\n    applies_to: ${appliesTo}\n${rest}`);

  it('lists pr, issue or both, in the order written', () => {
    expect(manual('[pr]').automations[0].appliesTo).toEqual(['pr']);
    expect(manual('[issue]').automations[0].appliesTo).toEqual(['issue']);
    expect(manual('[issue, pr]').automations[0].appliesTo).toEqual(['issue', 'pr']);
    expect(manual('[pr, issue]').issues).toEqual([]);
  });

  it('is for on: manual only', () => {
    const message = '`applies_to` is for `on: manual`: it says which items a run on demand takes.';
    for (const on of [
      '{ cron: "0 9 * * *" }',
      '{ github: { events: [pull_request.review_requested] } }',
      `{ poll: { ${POLL_BASE} } }`,
    ]) {
      const result = one(
        `    on: ${on}\n    applies_to: [pr]\n    run: { prompt: "x" }\n    scope: api\n`,
      );
      expect(issues(result)).toEqual([['automations[0].applies_to', message]]);
    }
  });

  it('refuses other kinds, repeats and an empty list', () => {
    expect(issues(manual('[mr]'))).toEqual([
      ['automations[0].applies_to', 'Expected `pr`, `issue` or both.'],
    ]);
    expect(issues(manual('[]'))).toEqual([
      ['automations[0].applies_to', 'Expected `pr`, `issue` or both.'],
    ]);
    expect(issues(manual('[pr, pr]'))).toEqual([
      ['automations[0].applies_to', '`pr` is listed twice.'],
    ]);
  });
});

describe('where a manual or poll entry runs', () => {
  const STEPS = '    steps:\n      - id: s\n        run: echo\n';

  it('takes no scope when it runs on a pull request or issue', () => {
    const result = one(
      '    on: manual\n    applies_to: [pr]\n    run: { prompt: "x" }\n    scope: api\n',
    );
    expect(issues(result)).toEqual([
      [
        'automations[0].scope',
        'A run on a pull request or issue works in a checkout of its own repository, so it takes no scope.',
      ],
    ]);
  });

  it('needs a scope when a manual entry has no item', () => {
    expect(issues(one('    on: manual\n    run: { prompt: "x" }\n'))).toEqual([
      ['automations[0].scope', NO_ITEM_SCOPE],
    ]);
    expect(issues(one(`    on: manual\n${STEPS}`))).toEqual([
      ['automations[0].scope', NO_ITEM_SCOPE],
    ]);
    expect(one('    on: manual\n    run: { tool: consola#list_sessions }\n').issues).toEqual([]);
  });

  it('needs a scope when a keyed poll has no repository to run in; an item: poll leaves it to the runner', () => {
    expect(issues(one(`    on: { poll: { ${POLL_BASE} } }\n${STEPS}`))).toEqual([
      ['automations[0].scope', NO_ITEM_SCOPE],
    ]);
    const withItem = one(
      `    on: { poll: { every: 30m, run: x, item: { github: .url } } }\n${RUN}    scope: api\n`,
    );
    expect(withItem.issues).toEqual([]);
  });

  it('keeps the schedule wording for cron', () => {
    expect(issues(one('    on: { cron: "0 9 * * *" }\n    run: { prompt: "x" }\n'))).toEqual([
      [
        'automations[0].scope',
        'Say where this runs: `scope: <one of the workspace’s scopes>`. A schedule has no item to run on.',
      ],
    ]);
  });

  it('refuses an action where there is no pull request or issue', () => {
    expect(issues(one('    on: manual\n    run: { action: Review }\n'))).toEqual([
      [
        'automations[0].run',
        'An action is a verb on an item, and this automation has none: write the job as `run: { prompt: "…" }`.',
      ],
    ]);
    expect(
      issues(one(`    on: { poll: { ${POLL_BASE} } }\n    run: { action: Review }\n`)),
    ).toEqual([
      [
        'automations[0].run',
        'An action is a verb on a pull request or issue, and this poll’s items are neither: write it as a prompt.',
      ],
    ]);
  });
});
