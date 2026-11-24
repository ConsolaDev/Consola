import { describe, expect, it } from 'vitest';
import { agentHash, HARNESS_ID_PATTERN, MAX_AGENT_BODY_BYTES, parseAgentFile } from './agents';
import type { ParsedAgent } from './agents';
import { AGENT_SECRETS_REASON } from './secrets';

const BODY = 'You investigate production alerts.\n';
const agent = (front: string, body = BODY) =>
  parseAgentFile('investigator', `---\n${front}---\n${body}`);
const parsed = (front: string, body = BODY): ParsedAgent => {
  const result = agent(front, body);
  expect(result.issues).toEqual([]);
  return result.agent!;
};
const only = (result: ReturnType<typeof parseAgentFile>) => {
  expect(result.agent).toBeUndefined();
  expect(result.issues).toHaveLength(1);
  return result.issues[0];
};
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const ENVIRONMENT_NAME =
  'Expected `environment` to be the name of a file in environments/, without `.yaml`: lowercase letters, digits and dashes, e.g. `environment: sandboxed`.';

const INVESTIGATOR = `---
description: Investigates production alerts for the catalog-portal services.
harness: claude-work
model: opus
tools: read-only
mcpServers:
  - claude.ai Coralogix
  - grafana: [query_logs, list_dashboards]
skills: [incident-triage]
max_turns: 30
---
You investigate production alerts for the catalog-portal services. Start from
the alert's query, correlate logs and traces, and end with cause, impact and
the next action.
`;

const COMPILED =
  "Consola compiles an agent's permissions from `tools`, `mcpServers` and `skills`; it takes no others.";
const NEEDS_HARNESS =
  'An agent that names servers or skills names its harness too: add `harness: <id>`, the harness whose CLI has them.';
const FORMAT_CHARACTERS = (what: string) =>
  `${what} is visible text: letters, numbers, punctuation, symbols and plain spaces, with no line or paragraph separators, combining marks, invisible fillers or format characters, which make text read as something else.`;
const SERVERS =
  'Expected `mcpServers` to be a list of server names, each optionally narrowed to its tools: `- notion` or `- grafana: [query_logs]`.';
const TOOL_NAME =
  "A tool name is the server's own: letters, digits, `_`, `.` and `-`, at most 64 characters.";
const SKILLS =
  'Expected `skills` to be a list of folder names in skills/, e.g. `[incident-triage]`.';
const MAX_TURNS = 'Expected `max_turns` to be a whole number from 1 to 500.';
const H = 'harness: claude-work\n';
const list = (count: number, prefix: string) =>
  `[${Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(', ')}]`;

describe('parseAgentFile', () => {
  it("takes the spec's investigator", () => {
    const { agent: investigator, issues } = parseAgentFile('investigator', INVESTIGATOR);
    expect(issues).toEqual([]);
    expect(investigator).toMatchObject({
      name: 'investigator',
      description: 'Investigates production alerts for the catalog-portal services.',
      harness: 'claude-work',
      model: 'opus',
      tools: 'read-only',
      mcpServers: [
        { name: 'claude.ai Coralogix' },
        { name: 'grafana', tools: ['query_logs', 'list_dashboards'] },
      ],
      skills: ['incident-triage'],
      maxTurns: 30,
    });
    expect(investigator!.body).toBe(
      "You investigate production alerts for the catalog-portal services. Start from\nthe alert's query, correlate logs and traces, and end with cause, impact and\nthe next action.\n",
    );
    expect(investigator!.lines).toEqual({ harness: 3, model: 4, mcpServers: 6, skills: 9 });
  });

  it('defaults', () => {
    const defaults = parsed('');
    expect(defaults).toMatchObject({ tools: 'read-only', mcpServers: [], skills: [], body: BODY });
    for (const key of ['harness', 'model', 'description', 'maxTurns'])
      expect(own(defaults, key), key).toBe(false);
    expect(defaults.lines).toEqual({});
  });

  it('a body-only file is an agent', () => {
    const { agent: noter, issues } = parseAgentFile('noter', 'Write short notes.\n');
    expect(issues).toEqual([]);
    expect(noter).toMatchObject({
      name: 'noter',
      body: 'Write short notes.\n',
      tools: 'read-only',
    });
  });

  it('takes tools: read-only, a server written as a mapping and a skill list', () => {
    expect(
      parsed(`${H}tools: read-only\nmcpServers: [{ notion: [search] }]\nskills: [a, b]\n`),
    ).toMatchObject({
      mcpServers: [{ name: 'notion', tools: ['search'] }],
      skills: ['a', 'b'],
    });
  });

  it.each([
    // Slice 3-B: a write agent names its environment; a read-only one names none.
    [
      'tools: write\n',
      'tools',
      'A write agent must name its environment (invariant 9); add `environment: <name>`.',
    ],
    [
      'tools: edit\n',
      'tools',
      'A write agent must name its environment (invariant 9); add `environment: <name>`.',
    ],
    [
      'environment: sandbox\n',
      'environment',
      'A read-only agent has no shell, so an environment would contain nothing; remove it.',
    ],
    [
      'tools: read-only\nenvironment: sandbox\n',
      'environment',
      'A read-only agent has no shell, so an environment would contain nothing; remove it.',
    ],
    ['tools: admin\n', 'tools', '`tools:` is `read-only`, `edit` or `write`.'],
    ['tools: [read-only]\n', 'tools', '`tools:` is `read-only`, `edit` or `write`.'],
    ['tools: Write\n', 'tools', '`tools:` is `read-only`, `edit` or `write`.'],
    ['tools: write\nenvironment: Sandboxed\n', 'environment', ENVIRONMENT_NAME],
    ['tools: write\nenvironment: [sandboxed]\n', 'environment', ENVIRONMENT_NAME],
    ['tools: write\nenvironment: ""\n', 'environment', ENVIRONMENT_NAME],
    ['secrets: [x]\n', 'secrets', AGENT_SECRETS_REASON],
    ['hooks: {}\n', 'hooks', COMPILED],
    ['permissionMode: plan\n', 'permissionMode', COMPILED],
    ['allowed-tools: [Bash]\n', 'allowed-tools', COMPILED],
    ['allowedTools: [Bash]\n', 'allowedTools', COMPILED],
    [
      'name: investigator\n',
      'name',
      "The file's name is the agent's name: remove `name:`, or rename the file.",
    ],
    ['color: blue\n', 'color', 'Unrecognized key in an agent file: `color`.'],
    ['toString: x\n', 'toString', 'Unrecognized key in an agent file: `toString`.'],
    ['mcpServers: [notion]\n', 'mcpServers', NEEDS_HARNESS],
    ['skills: [incident-triage]\n', 'skills', NEEDS_HARNESS],
    [
      `description: ${'d'.repeat(201)}\n`,
      'description',
      'Expected `description` to be one line of at most 200 characters.',
    ],
    [
      'description: "a\\nb"\n',
      'description',
      'Expected `description` to be one line of at most 200 characters.',
    ],
    [
      'description: ""\n',
      'description',
      'Expected `description` to be one line of at most 200 characters.',
    ],
    // Format characters (bidi overrides, zero-width) make shown text read as other text (review M8).
    [
      'description: "Reviews \\u202Egnp.sdrawkcab"\n',
      'description',
      FORMAT_CHARACTERS('`description`'),
    ],
    ['description: "Reviews\\u200Bquietly"\n', 'description', FORMAT_CHARACTERS('`description`')],
    [
      'harness: claude work\n',
      'harness',
      "Expected `harness` to be a harness's id, as Settings › Harnesses shows it: letters, digits, `_` and `-`.",
    ],
    [
      "model: ''\n",
      'model',
      "Expected `model` to be a model the harness's CLI takes, e.g. `opus`, `haiku` or a full model id.",
    ],
    [
      "model: 'two words'\n",
      'model',
      "Expected `model` to be a model the harness's CLI takes, e.g. `opus`, `haiku` or a full model id.",
    ],
    [
      'model: --dangerously-skip-permissions\n',
      'model',
      "Expected `model` to be a model the harness's CLI takes, e.g. `opus`, `haiku` or a full model id.",
    ],
    [`${H}mcpServers: notion\n`, 'mcpServers', SERVERS],
    [`${H}mcpServers: ["a\\nb"]\n`, 'mcpServers', SERVERS],
    [`${H}mcpServers: ["noti\\u200Bon"]\n`, 'mcpServers', FORMAT_CHARACTERS('A server name')],
    [
      `${H}mcpServers: [{ "noti\\u202Eon": [search] }]\n`,
      'mcpServers',
      FORMAT_CHARACTERS('A server name'),
    ],
    [`${H}mcpServers: [{ grafana: [] }]\n`, 'mcpServers', SERVERS],
    [`${H}mcpServers: ${list(21, 's')}\n`, 'mcpServers', 'An agent names at most 20 servers.'],
    [`${H}mcpServers: [notion, notion]\n`, 'mcpServers', '`notion` is listed twice.'],
    [`${H}mcpServers: [notion, { notion: [search] }]\n`, 'mcpServers', '`notion` is listed twice.'],
    [`${H}mcpServers: [{ grafana: [query log] }]\n`, 'mcpServers', TOOL_NAME],
    [`${H}mcpServers: [{ grafana: [${'t'.repeat(65)}] }]\n`, 'mcpServers', TOOL_NAME],
    [`${H}mcpServers: [{ grafana: [a, a] }]\n`, 'mcpServers', '`a` is listed twice.'],
    [`${H}mcpServers: [{ grafana: [a, b], notion: [c] }]\n`, 'mcpServers', SERVERS],
    [`${H}skills: incident-triage\n`, 'skills', SKILLS],
    [`${H}skills: [Incident]\n`, 'skills', SKILLS],
    [`${H}skills: ${list(21, 's')}\n`, 'skills', 'An agent names at most 20 skills.'],
    [
      `${H}skills: [incident-triage, incident-triage]\n`,
      'skills',
      '`incident-triage` is listed twice.',
    ],
    ['max_turns: 0\n', 'max_turns', MAX_TURNS],
    ['max_turns: 501\n', 'max_turns', MAX_TURNS],
    ['max_turns: 2.5\n', 'max_turns', MAX_TURNS],
    ["max_turns: '6'\n", 'max_turns', MAX_TURNS],
  ])('refuses %j', (front, path, message) => {
    expect(only(agent(front))).toMatchObject({ file: 'agents/investigator.md', path, message });
  });

  describe("visible text only, on a card (the review's validator differential)", () => {
    // Each makes a description, a server name or a model read as other text on a card, or break a line.
    const INVISIBLE: Array<[string, string]> = [
      ['a line separator', String.raw`\u2028`],
      ['a paragraph separator', String.raw`\u2029`],
      ['a variation selector', String.raw`\uFE0F`],
      ['an enclosing mark', String.raw`\u20DD`],
      ['a combining mark that composes with nothing', String.raw`\u0336`],
      ['the Hangul choseong filler', String.raw`\u115F`],
      ['the Hangul jungseong filler', String.raw`\u1160`],
      ['the Hangul filler', String.raw`\u3164`],
      ['the halfwidth Hangul filler', String.raw`\uFFA0`],
      ['the blank Braille pattern', String.raw`\u2800`],
      ['a no-break space', String.raw`\u00A0`],
      ['an ideographic space', String.raw`\u3000`],
      ['a zero-width space', String.raw`\u200B`],
    ];

    it.each(INVISIBLE)('refuses %s in a description', (_, escaped) => {
      expect(only(agent(`description: "Reviews${escaped}the PR"\n`))).toMatchObject({
        path: 'description',
        message: FORMAT_CHARACTERS('`description`'),
      });
    });

    it.each(INVISIBLE)('refuses %s in a server name, bare or narrowed', (_, escaped) => {
      for (const servers of [`["noti${escaped}on"]`, `[{ "noti${escaped}on": [search] }]`]) {
        expect(only(agent(`${H}mcpServers: ${servers}\n`))).toMatchObject({
          path: 'mcpServers',
          message: FORMAT_CHARACTERS('A server name'),
        });
      }
    });

    it.each(
      INVISIBLE.filter(
        ([, escaped]) =>
          ![
            String.raw`\u00A0`,
            String.raw`\u3000`,
            String.raw`\u2028`,
            String.raw`\u2029`,
          ].includes(escaped),
      ),
    )('refuses %s in a model', (_, escaped) => {
      expect(only(agent(`model: "opus${escaped}"\n`))).toMatchObject({
        path: 'model',
        message: FORMAT_CHARACTERS('`model`'),
      });
    });

    it('takes the names and descriptions people write', () => {
      const taken = parsed(
        `${H}description: "Reviews catalog-portal’s PRs — fast, in 日本語 too; 100% (ok)."\nmcpServers: [claude.ai Coralogix, grafana-prod_2, servidor-é, "tools 🔧", { notion: [search] }]\nmodel: claude-opus-4-1@20250805\n`,
      );
      expect(taken.description).toBe(
        'Reviews catalog-portal’s PRs — fast, in 日本語 too; 100% (ok).',
      );
      expect(taken.mcpServers.map((server) => server.name)).toEqual([
        'claude.ai Coralogix',
        'grafana-prod_2',
        'servidor-é',
        'tools 🔧',
        'notion',
      ]);
    });

    it('reads a server name and a description NFC-normalised, so two spellings are one name and one hash', () => {
      const decomposed = 'servidor-é';
      const composed = 'servidor-é';
      const nfd = parsed(`${H}description: "Caf${'é'}"\nmcpServers: ["${decomposed}"]\n`);
      const nfc = parsed(`${H}description: "Café"\nmcpServers: ["${composed}"]\n`);
      expect(nfd.mcpServers).toEqual([{ name: composed }]);
      expect(nfd.description).toBe('Café');
      expect(agentHash(nfd, {})).toBe(agentHash(nfc, {}));
      expect(parsed(`${H}mcpServers: [{ "${decomposed}": [search] }]\n`).mcpServers).toEqual([
        { name: composed, tools: ['search'] },
      ]);
      expect(only(agent(`${H}mcpServers: ["${decomposed}", "${composed}"]\n`))).toMatchObject({
        path: 'mcpServers',
        message: `\`${composed}\` is listed twice.`,
      });
    });
  });

  it('takes 20 servers, 20 skills, a 200-character description and max_turns 1 and 500', () => {
    parsed(`${H}mcpServers: ${list(20, 's')}\nskills: ${list(20, 's')}\n`);
    expect(parsed(`description: ${'d'.repeat(200)}\n`).description).toHaveLength(200);
    expect(parsed('max_turns: 1\n').maxTurns).toBe(1);
    expect(parsed('max_turns: 500\n').maxTurns).toBe(500);
    expect(parsed('model: claude-opus-4-1@20250805\n').model).toBe('claude-opus-4-1@20250805');
  });

  it('points a key at its line', () => {
    expect(only(agent('model: opus\ncolor: blue\n')).line).toBe(3);
  });

  it.each([
    [
      '{{item.title}}',
      '{{item.title}}\n',
      "An agent's instructions are the same for every step that uses it: put item values in the step's `prompt:`.",
    ],
    [
      'an empty body',
      '\n \n',
      'An agent file needs its instructions after the frontmatter: at least one line that is not blank.',
    ],
    [
      'a body over 64 KiB',
      'b'.repeat(MAX_AGENT_BODY_BYTES + 1),
      "An agent's instructions are at most 64 KB.",
    ],
  ])('refuses %s in the body, at its first line', (_, body, message) => {
    expect(only(agent('model: opus\n', body))).toMatchObject({
      file: 'agents/investigator.md',
      path: '',
      message,
      line: 4,
    });
  });

  it('takes a body of exactly 64 KiB, counted in bytes', () => {
    expect(parsed('', 'b'.repeat(MAX_AGENT_BODY_BYTES)).body).toHaveLength(MAX_AGENT_BODY_BYTES);
    // Three bytes each in UTF-8: one more character is over.
    const wide = '€'.repeat(Math.floor(MAX_AGENT_BODY_BYTES / 3));
    parsed('', wide);
    expect(only(agent('', `${wide}€`)).message).toBe("An agent's instructions are at most 64 KB.");
  });

  describe('frontmatter edges', () => {
    it('refuses an unclosed frontmatter', () => {
      expect(only(parseAgentFile('investigator', '---\nmodel: opus\n'))).toMatchObject({
        path: '',
        line: 1,
        message: "An agent file's frontmatter ends with a line of `---`.",
      });
    });

    it('refuses a frontmatter that is not a mapping', () => {
      expect(only(parseAgentFile('investigator', '---\n- a\n---\nx'))).toMatchObject({
        path: '',
        message: 'The frontmatter is a mapping of keys, e.g. `model: opus`.',
      });
    });

    it('refuses YAML that does not parse, at its line', () => {
      const issue = only(agent('model: opus\nskills: [a\n'));
      expect(issue).toMatchObject({ file: 'agents/investigator.md', path: '' });
      expect(issue.line).toBeGreaterThanOrEqual(3);
    });

    it('reads CRLF throughout and a leading BOM as the same agent, its body as written', () => {
      const crlf = parseAgentFile('investigator', `\uFEFF${INVESTIGATOR.replace(/\n/g, '\r\n')}`);
      const lf = parseAgentFile('investigator', INVESTIGATOR);
      expect(crlf.issues).toEqual([]);
      const { body: crlfBody, ...crlfRest } = crlf.agent!;
      const { body: lfBody, ...lfRest } = lf.agent!;
      expect(crlfRest).toEqual(lfRest);
      expect(crlfBody).toBe(lfBody.replace(/\n/g, '\r\n'));
      expect(crlf.agent!.lines.harness).toBe(3);
      expect(agentHash(crlf.agent!, {})).not.toBe(agentHash(lf.agent!, {}));
    });

    it('refuses a file name that is no name', () => {
      expect(only(parseAgentFile('Investigator', INVESTIGATOR))).toMatchObject({
        file: 'agents/Investigator.md',
        path: '',
        message:
          "`agents/Investigator.md`: an agent's file name is its name: lowercase letters, digits and dashes, e.g. agents/investigator.md.",
      });
    });
  });

  it('copies the desktop harness id pattern', () => {
    expect(HARNESS_ID_PATTERN.test('claude-work_2')).toBe(true);
    expect(HARNESS_ID_PATTERN.test('claude work')).toBe(false);
  });
});

describe('agentHash', () => {
  const base = parseAgentFile('investigator', INVESTIGATOR).agent!;
  const skills = { 'incident-triage': 'a'.repeat(64) };
  const hashOf = (text: string, skillHashes: Record<string, string> = skills) => {
    const result = parseAgentFile('investigator', text);
    expect(result.issues).toEqual([]);
    return agentHash(result.agent!, skillHashes);
  };
  const baseHash = agentHash(base, skills);
  const edit = (from: string, to: string) => {
    expect(INVESTIGATOR).toContain(from);
    return hashOf(INVESTIGATOR.replace(from, to));
  };

  it('is full sha256 hex', () => {
    expect(baseHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change with the order of the frontmatter keys', () => {
    expect(edit('harness: claude-work\nmodel: opus\n', 'model: opus\nharness: claude-work\n')).toBe(
      baseHash,
    );
  });

  it.each([
    ['one byte of the body', 'the next action.', 'the next action!'],
    ['harness', 'harness: claude-work', 'harness: claude-personal'],
    ['model', 'model: opus', 'model: haiku'],
    ['max_turns', 'max_turns: 30', 'max_turns: 31'],
    ['description', 'catalog-portal services.\nharness', 'catalog-portal service.\nharness'],
    ['a server', '  - claude.ai Coralogix\n', '  - claude.ai Sentry\n'],
    ["a server's narrowing", 'list_dashboards]', 'list_panels]'],
    ["a skill's name", 'skills: [incident-triage]', 'skills: [triage]'],
  ])('changes with %s', (_, from, to) => {
    expect(edit(from, to)).not.toBe(baseHash);
  });

  it('changes when a named skill’s hash changes, and not for an unnamed one', () => {
    expect(agentHash(base, { 'incident-triage': 'b'.repeat(64) })).not.toBe(baseHash);
    expect(agentHash(base, { ...skills, other: 'c'.repeat(64) })).toBe(baseHash);
  });
});

describe('write tools and an environment (slice 3-B)', () => {
  it.each([['edit'], ['write']])('takes tools: %s with an environment', (tools) =>
    expect(
      parseAgentFile('fixer', `---\ntools: ${tools}\nenvironment: sandboxed\n---\nFix it.\n`).agent,
    ).toMatchObject({ tools, environment: 'sandboxed', lines: { tools: 2, environment: 3 } }),
  );

  it.each([
    [
      'tools: write',
      'A write agent must name its environment (invariant 9); add `environment: <name>`.',
    ],
    [
      'environment: sandboxed',
      'A read-only agent has no shell, so an environment would contain nothing; remove it.',
    ],
    ['tools: admin', '`tools:` is `read-only`, `edit` or `write`.'],
  ])('refuses %s', (front, words) =>
    expect(parseAgentFile('a', `---\n${front}\n---\nx\n`).issues.map((i) => i.message)).toContain(
      words,
    ),
  );

  it('a read-only agent parses and hashes as before', () => {
    const agent = parseAgentFile(
      'triager',
      '---\nharness: claude-work\nmodel: haiku\n---\nTriage it.\n',
    ).agent!;
    // Computed with the code before slice 3-B (`cba8d0d6`), from its built package.
    expect(agentHash(agent, {})).toBe(
      'c76629419320a660ad2e5ae45011797903b40b253f59e562feadc2b601c08670',
    );
    expect(own(agent, 'environment')).toBe(false);
    expect(agent.lines).toEqual({ harness: 2, model: 3 });
    const readOnly = parseAgentFile(
      'triager',
      '---\nharness: claude-work\nmodel: haiku\ntools: read-only\n---\nTriage it.\n',
    ).agent!;
    expect(agentHash(readOnly, {})).toBe(agentHash(agent, {}));
  });

  it('the hash covers the tools and the environment', () => {
    const hashOf = (front: string) =>
      agentHash(parseAgentFile('fixer', `---\n${front}---\nFix it.\n`).agent!, {});
    const write = hashOf('tools: write\nenvironment: sandboxed\n');
    expect(hashOf('tools: edit\nenvironment: sandboxed\n')).not.toBe(write);
    expect(hashOf('tools: write\nenvironment: mine\n')).not.toBe(write);
    expect(hashOf('')).not.toBe(write);
    expect(hashOf('environment: sandboxed\ntools: write\n')).toBe(write);
  });
});
