import { describe, expect, it } from 'vitest';
import { parseFactorySpec, parseFactoryYml } from './parse';

const VALID = `
version: 1
automations:
  - name: clean-up-stale-sessions
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged, closed] } }
    mode: auto
`;

describe('parseFactorySpec', () => {
  it('loads a valid automation with its parsed target and source line', () => {
    const result = parseFactorySpec(VALID);
    expect(result.issues).toEqual([]);
    expect(result.automations).toEqual([
      {
        name: 'clean-up-stale-sessions',
        trigger: { kind: 'cron', cron: '0 9 * * *' },
        run: {
          kind: 'tool',
          ref: 'consola#cleanup_stale_sessions',
          namespace: 'consola',
          tool: 'cleanup_stale_sessions',
          with: { pr_states: ['merged', 'closed'] },
        },
        mode: 'auto',
        line: 4,
      },
    ]);
  });

  it('defaults mode to confirm and with to {}', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "*/5 * * * *" }\n    run: { tool: consola#x }\n',
    );
    expect(result.issues).toEqual([]);
    expect(result.automations[0]).toMatchObject({ mode: 'confirm', run: { with: {} } });
  });

  it('says why a workspace selector is not needed', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n    workspace: Acme\n',
    );
    expect(result.automations).toEqual([]);
    expect(result.issues).toMatchObject([
      {
        path: 'automations[0].workspace',
        message: expect.stringMatching(/belongs to one workspace/),
        line: 6,
      },
    ]);
  });

  it('treats an empty or comments-only file as no automations', () => {
    expect(parseFactorySpec('')).toEqual({ automations: [], issues: [] });
    expect(parseFactorySpec('# nothing yet\n')).toEqual({ automations: [], issues: [] });
  });

  it('treats an automations key with nothing under it as no automations', () => {
    // What a file looks like once its last automation is commented out.
    const text = 'version: 1\nautomations:\n  # - name: a\n  #   on: { cron: "0 9 * * *" }\n';
    expect(parseFactorySpec(text)).toEqual({ automations: [], issues: [] });
  });

  it('loads nothing and reports the line when the YAML itself is broken', () => {
    const result = parseFactorySpec('version: 1\nautomations:\n  - name: a\n   bad: [\n');
    expect(result.automations).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].line).toBeGreaterThan(0);
  });

  it('requires version: 1', () => {
    const result = parseFactorySpec('automations: []\n');
    expect(result.automations).toEqual([]);
    expect(result.issues[0]).toMatchObject({ path: 'version' });
    expect(result.issues[0].message).toContain('version: 1');
  });

  it('rejects unknown top-level keys, pointing at the key', () => {
    const result = parseFactorySpec('version: 1\nautomation: []\n');
    expect(result.automations).toEqual([]);
    expect(result.issues[0]).toMatchObject({ line: 2 });
  });

  it('isolates a bad entry: its siblings still load', () => {
    const result = parseFactorySpec(`version: 1
automations:
  - name: good
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
  - name: bad
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
    mode: sometimes
`);
    expect(result.automations.map((a) => a.name)).toEqual(['good']);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      automation: 'bad',
      path: 'automations[1].mode',
      line: 9,
    });
  });

  it('rejects a bad cron expression with the reason', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "every day" }\n    run: { tool: consola#x }\n',
    );
    expect(result.automations).toEqual([]);
    expect(result.issues[0].path).toBe('automations[0].on.cron');
    expect(result.issues[0].message).toMatch(/five cron fields/);
  });

  it('rejects six-field (seconds) cron for portability', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 0 9 * * *" }\n    run: { tool: consola#x }\n',
    );
    expect(result.issues[0].message).toMatch(/five cron fields/);
  });

  it('rejects unknown keys on an entry', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n    moed: auto\n',
    );
    expect(result.issues[0]).toMatchObject({ automation: 'a', line: 6 });
  });

  it('rejects names that are not kebab-case identifiers', () => {
    const result = parseFactorySpec(
      'version: 1\nautomations:\n  - name: Clean Up\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n',
    );
    expect(result.issues[0].path).toBe('automations[0].name');
  });

  it('rejects duplicate names, keeping the first', () => {
    const entry = '  - name: a\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n';
    const result = parseFactorySpec(`version: 1\nautomations:\n${entry}${entry}`);
    expect(result.automations).toHaveLength(1);
    expect(result.issues[0].message).toMatch(/Duplicate automation name "a"/);
    expect(result.issues[0].line).toBe(6);
  });

  it.each([
    ['policy', '{}', '`policy` arrives with shared factories; it is not supported yet.'],
    ['library', 'x', '`library` arrives with shared factories; it is not supported yet.'],
    ['defaults', '{}', '`defaults` arrives with shared factories; it is not supported yet.'],
    ['name', 'sprocket', '`name` arrives with shared factories; it is not supported yet.'],
    [
      'connections',
      '[]',
      '`connections` arrives with connection manifests, the second part of connections as data.',
    ],
  ])('refuses %s at the top level, at its line, loading nothing', (key, value, message) => {
    const result = parseFactorySpec(`${VALID}${key}: ${value}\n`);
    expect(result.automations).toEqual([]);
    expect(result.issues).toEqual([{ message, path: key, line: 8 }]);
  });

  it('reads mcpServers: into its servers, with no issue in the envelope', () => {
    const text = `${VALID}mcpServers:
  slack:
    command: npx
    args: [-y, "@sprocket/slack-mcp@1.4.2"]
    secrets: [SLACK_BOT_TOKEN]
`;
    expect(parseFactorySpec(text)).toEqual(parseFactorySpec(VALID));
    const read = parseFactoryYml(text);
    expect(read.unreadable).toBe(false);
    expect(read.issues).toEqual([]);
    expect(read.servers).toEqual({
      slack: {
        name: 'slack',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@sprocket/slack-mcp@1.4.2'],
        env: {},
        secrets: ['SLACK_BOT_TOKEN'],
      },
    });
    expect(read.brokenServers).toEqual([]);
    expect(read.serverNotices).toEqual([]);
    expect(read.automations.map((automation) => automation.name)).toEqual([
      'clean-up-stale-sessions',
    ]);
  });

  it("reports a broken server at its key and line, and still loads the file's automations", () => {
    const text = `${VALID}mcpServers:
  slack:
    command: npx
    cwd: /Users/alice/catalog-portal
  tracker:
    url: https://mcp.tracker.sprocket.example/mcp
`;
    const read = parseFactoryYml(text);
    expect(read.unreadable).toBe(false);
    expect(read.issues).toEqual([
      {
        message: 'Consola decides where a server starts, and it is never a checkout.',
        path: 'mcpServers.slack.cwd',
        line: 11,
        file: 'factory.yml',
      },
    ]);
    expect(read.brokenServers).toEqual(['slack']);
    expect(Object.keys(read.servers)).toEqual(['tracker']);
    expect(read.automations.map((automation) => automation.name)).toEqual([
      'clean-up-stale-sessions',
    ]);
    expect(parseFactorySpec(text).automations).toHaveLength(1);
  });

  it('refuses an mcpServers: that is not a mapping at mcpServers, loading the automations', () => {
    const read = parseFactoryYml(`${VALID}mcpServers: [notion]\n`);
    expect(read.unreadable).toBe(false);
    expect(read.issues).toEqual([
      {
        message: 'Expected `mcpServers:` to be a mapping of server name to its definition.',
        path: 'mcpServers',
        line: 8,
        file: 'factory.yml',
      },
    ]);
    expect(read.servers).toEqual({});
    expect(read.automations).toHaveLength(1);
  });

  it('keeps the unpinned warning apart from the issues, at the package', () => {
    const read = parseFactoryYml(`${VALID}mcpServers:
  slack:
    command: npx
    args: [-y, "@sprocket/slack-mcp"]
`);
    expect(read.issues).toEqual([]);
    expect(read.serverNotices).toEqual([
      {
        message: 'This runs the newest version at every call, unattended; pin one.',
        path: ['mcpServers', 'slack', 'args', 1],
      },
    ]);
    expect(read.lineAt(read.serverNotices[0].path)).toBe(11);
  });

  it('leaves out an entry whose step names an agent, saying why, and loads the rest', () => {
    const result = parseFactorySpec(`version: 1
automations:
  - name: investigate
    on: { github: { events: [pull_request.review_requested] } }
    steps:
      - prompt: Read it.
      - agent: investigator
  - name: clean-up-stale-sessions
    on: { cron: "0 9 * * *" }
    run: { tool: consola#cleanup_stale_sessions }
`);
    expect(result.automations.map((automation) => automation.name)).toEqual([
      'clean-up-stale-sessions',
    ]);
    expect(result.issues).toEqual([
      {
        message:
          '`agent: investigator` names agents/investigator.md, and this factory.yml is read without its folder.',
        path: 'automations[0].steps[1].agent',
        line: 7,
        automation: 'investigate',
      },
    ]);
    for (const value of [...result.automations, ...result.issues])
      expect(Object.prototype.hasOwnProperty.call(value, 'file')).toBe(false);
  });

  it('adds no file to what it returns, issues included', () => {
    const result = parseFactorySpec(
      `${VALID}  - name: bad\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n    mode: sometimes\n`,
    );
    expect(result.automations).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    for (const value of [...result.automations, ...result.issues])
      expect(Object.prototype.hasOwnProperty.call(value, 'file')).toBe(false);
  });
});

describe('repos: (slice 3-B)', () => {
  const messages = (yaml: string) => parseFactoryYml(yaml).issues.map((issue) => issue.message);

  it('reads repos:', () => {
    expect(
      parseFactoryYml('version: 1\nrepos: [sprocket/catalog-portal]\nautomations: []\n').repos,
    ).toEqual(['sprocket/catalog-portal']);
    expect(parseFactoryYml('version: 1\nautomations: []\n').repos).toEqual([]);
  });

  it.each([
    ['repos: [catalog-portal]', 'is a repository as `owner/name`'],
    ['repos: [a/b, A/B]', '`A/B` is listed twice in `repos:`.'],
    ['repos: [A/B, a/b]', '`a/b` is listed twice in `repos:`.'],
    [
      `repos: [${Array.from({ length: 51 }, (_, i) => `o/r${i}`).join(', ')}]`,
      '`repos:` lists at most 50 repositories.',
    ],
    // Beyond the plan's rows: not a list, and an entry that is not text.
    ['repos: sprocket/catalog-portal', '`repos:` lists repositories as `owner/name`'],
    ['repos: [7]', 'is a repository as `owner/name`'],
  ])('refuses %s', (yaml, words) =>
    expect(messages(`version: 1\n${yaml}\nautomations: []\n`)).toContainEqual(
      expect.stringContaining(words),
    ),
  );

  it('points at the entry, loads nothing, as for any problem with the file as a whole', () => {
    const result = parseFactoryYml(
      'version: 1\nrepos:\n  - sprocket/catalog-portal\n  - catalog-portal\nautomations: []\n',
    );
    expect(result.unreadable).toBe(true);
    expect(result.repos).toEqual([]);
    expect(result.issues).toEqual([
      {
        message:
          'Each entry of `repos:` is a repository as `owner/name`, e.g. `sprocket/catalog-portal`.',
        path: 'repos[1]',
        line: 4,
        file: 'factory.yml',
      },
    ]);
  });

  it('takes 50, and an empty list', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `o/r${i}`).join(', ');
    expect(parseFactoryYml(`version: 1\nrepos: [${fifty}]\nautomations: []\n`).issues).toEqual([]);
    expect(parseFactoryYml('version: 1\nrepos: []\nautomations: []\n').repos).toEqual([]);
  });
});

describe('parseFactoryYml', () => {
  it('reads factory.yml as the folder does: agent steps kept, every automation and issue with its file', () => {
    const result = parseFactoryYml(`version: 1
automations:
  - name: investigate
    on: { github: { events: [pull_request.review_requested] } }
    steps:
      - agent: investigator
  - name: bad
    on: { cron: "0 9 * * *" }
    run: { tool: consola#x }
    mode: sometimes
`);
    expect(result.unreadable).toBe(false);
    expect(result.automations).toMatchObject([
      { name: 'investigate', file: 'factory.yml', line: 3 },
    ]);
    expect(result.issues).toMatchObject([{ file: 'factory.yml', automation: 'bad', line: 10 }]);
    expect(result.entryPath('investigate')).toEqual(['automations', 0]);
    expect(result.entryPath('bad')).toEqual(['automations', 1]);
    expect(result.entryPath('other')).toBeUndefined();
    expect(result.entryNames).toEqual(['investigate', 'bad']);
    expect(result.lineAt(['automations', 0, 'steps', 0, 'agent'])).toBe(6);
    expect(result.rangeAt(['automations', 0, 'steps', 0])).toMatchObject({ start: 6 });
    expect(result.rangeAt(['automations', 2])).toBeUndefined();
  });

  it('is unreadable when the YAML does not parse or its envelope fails, not for an entry', () => {
    expect(parseFactoryYml('version: 1\nautomations:\n  - name: a\n   bad: [\n').unreadable).toBe(
      true,
    );
    expect(parseFactoryYml('version: 2\nautomations: []\n').unreadable).toBe(true);
    expect(parseFactoryYml(`${VALID}  - name: bad\n    mode: sometimes\n`).unreadable).toBe(false);
    expect(parseFactoryYml('').unreadable).toBe(false);
  });

  it('points entryPath at the entry that loaded, not an earlier one of that name that failed', () => {
    const entry = '    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n';
    const result = parseFactoryYml(
      `version: 1\nautomations:\n  - name: a\n    mode: sometimes\n${entry}  - name: a\n${entry}`,
    );
    expect(result.automations).toHaveLength(1);
    expect(result.entryPath('a')).toEqual(['automations', 1]);
    expect(result.entryNames).toEqual(['a']);
  });

  it('points entryPath at the first of two failed entries of one name', () => {
    const entry =
      '    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n    mode: sometimes\n';
    const result = parseFactoryYml(
      `version: 1\nautomations:\n  - name: a\n${entry}  - name: a\n${entry}`,
    );
    expect(result.automations).toEqual([]);
    expect(result.entryPath('a')).toEqual(['automations', 0]);
  });

  it('equals parseFactorySpec on a slice-1 file but for file', () => {
    const text = `${VALID}  - name: bad\n    on: { cron: "0 9 * * *" }\n    run: { tool: consola#x }\n    mode: sometimes\n`;
    const folder = parseFactoryYml(text);
    const alone = parseFactorySpec(text);
    expect(folder.automations).toEqual(
      alone.automations.map((automation) => ({ ...automation, file: 'factory.yml' })),
    );
    expect(folder.issues).toEqual(alone.issues.map((issue) => ({ ...issue, file: 'factory.yml' })));
  });
});
