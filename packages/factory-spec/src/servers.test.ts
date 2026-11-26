import { describe, expect, it } from 'vitest';
import { parse as yaml } from 'yaml';
import { parseSecretNames, secretNameProblem } from './secrets';
import {
  MAX_SERVER_ARGS,
  MAX_SERVERS,
  MCP_SERVER_NAME_PATTERN,
  parseMcpServers,
  serverHash,
  unpinnedLauncher,
} from './servers';

type Issue = { message: string; path: Array<string | number> };

function parse(raw: unknown) {
  const issues: Issue[] = [];
  const result = parseMcpServers(raw, (message, path) => issues.push({ message, path }));
  return { ...result, issues };
}
const one = (definition: unknown) => parse({ slack: definition });
const issuesOf = (definition: unknown) => one(definition).issues;

// The words the plan fixes (Global Constraints), each asserted exactly.
const RELATIVE = (command: string) =>
  `\`${command}\` would run whatever is at that path in the folder the server starts in. Use an absolute path, or a program on your \`PATH\`.`;
const HELPER =
  'A helper is a command Consola would run on your machine to make headers, and it would be outside what you approved. Put the token in `secrets:` and use it in `headers:`.';
const NO_TYPE =
  'Remove `type:`: a server is the kind its key says, `command` for one Consola starts (stdio), `url` for one it calls (Streamable HTTP).';
const SSE = `The HTTP+SSE transport is deprecated (MCP 2025-03-26). Point \`url\` at the server's Streamable HTTP endpoint, usually \`/mcp\`. ${NO_TYPE}`;
const CWD = 'Consola decides where a server starts, and it is never a checkout.';
const SIGN_IN =
  'A sign-in for the engine is not supported yet: give the server a token in `secrets:`.';
const TIMEOUT = 'Set `timeout:` on the step that calls it.';
const CREDENTIAL =
  'This looks like a credential written into the file. Name it in `secrets:` and bind it on each runner.';
const UNKNOWN = (key: string) => `Unrecognized key in a server: \`${key}\`.`;
const UNPINNED = 'This runs the newest version at every call, unattended; pin one.';
const EXACTLY_ONE =
  'A server has exactly one of `command` (a program Consola starts) or `url` (a server Consola calls).';
const NAME = 'Use lowercase letters, digits and dashes, starting with a letter, e.g. slack.';
const CONSOLA = "`consola` is Consola's own tools; name this server something else.";
const TOO_MANY = '`mcpServers:` defines at most 20 servers.';
const NOT_A_MAPPING = 'Expected `mcpServers:` to be a mapping of server name to its definition.';
const NOT_A_SERVER = 'Expected a server: a mapping with `command` or `url`.';
const ARGS_TEMPLATE =
  'An argument is visible to every process on this Mac, so it takes no `${…}` or `{{ }}`: name the secret in `secrets:`, which reaches the server as its environment.';
const ARGS_COUNT = 'A server takes at most 50 `args`.';
const ENV_LITERAL = "A server's `env:` is literal: name a secret in `secrets:` instead.";
const URL_WORDS = '`url` is `https://…`, or `http://` on 127.0.0.1, localhost or [::1].';
const URL_TEMPLATE =
  'A URL is shown and logged as it is, so it takes no `${…}`: put the secret in a header.';
const NOT_ONE_OF = (name: string) =>
  `\`\${${name}}\` is not one of this server's \`secrets:\`; add it there, or write the value as it is.`;
const HEADER_BRACES = "A header takes `${NAME}` for one of the server's secrets, never `{{ }}`.";
const FOR_STDIO = (key: string) => `\`${key}\` is for a server Consola starts (\`command\`).`;
const FOR_HTTP = '`headers` is for a server Consola calls (`url`).';
const ONE_LINE = "A header's value is one line.";
// env:'s own words (spec/steps.ts), which a server's env: names follow.
const ENV_CONSOLA = "`CONSOLA_` is Consola's own namespace; pick another name.";
const ENV_PATTERN = 'Use uppercase letters, digits and underscores, e.g. PR_NUMBER.';
// 5a-1's: a command acts as the bound account.
const IDENTITY =
  "Commands act as the workspace's bound GitHub account, whose token Consola puts in `GH_TOKEN` (decision 37). To act as another account, bind it to the workspace.";

const SPEC_EXAMPLE = `
slack:
  description: Posts to Sprocket's Slack as the support bot.
  command: npx
  args: [-y, "@sprocket/slack-mcp@1.4.2"]
  env: { SLACK_TEAM_ID: T0SPROCKET }
  secrets: [SLACK_BOT_TOKEN]
tracker:
  url: https://mcp.tracker.sprocket.example/mcp
  headers: { Authorization: "Bearer \${TRACKER_TOKEN}" }
  secrets: [TRACKER_TOKEN]
`;

const STDIO = { command: 'node', args: ['/opt/sprocket/slack.js'] };
const HTTP = { url: 'https://mcp.tracker.sprocket.example/mcp' };

describe('parseMcpServers: the spec’s two servers', () => {
  it('reads a stdio server and a Streamable HTTP one, as written', () => {
    const result = parse(yaml(SPEC_EXAMPLE));
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.broken).toEqual([]);
    expect(result.servers).toEqual({
      slack: {
        name: 'slack',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@sprocket/slack-mcp@1.4.2'],
        env: { SLACK_TEAM_ID: 'T0SPROCKET' },
        secrets: ['SLACK_BOT_TOKEN'],
        description: "Posts to Sprocket's Slack as the support bot.",
      },
      tracker: {
        name: 'tracker',
        transport: 'http',
        url: 'https://mcp.tracker.sprocket.example/mcp',
        headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' },
        secrets: ['TRACKER_TOKEN'],
      },
    });
  });

  it('gives a server only the keys it was written with: no secrets or description when absent', () => {
    expect(one({ command: 'node' }).servers.slack).toEqual({
      name: 'slack',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    expect(one({ ...HTTP, secrets: [] }).servers.slack).toEqual({
      name: 'slack',
      transport: 'http',
      url: HTTP.url,
      headers: {},
    });
  });

  it('reads no servers from nothing, and none from YAML null', () => {
    for (const raw of [undefined, null]) {
      expect(parse(raw)).toEqual({ servers: {}, broken: [], warnings: [], issues: [] });
    }
  });
});

describe('parseMcpServers: the mapping and its names', () => {
  it('refuses a list in place of a mapping, at mcpServers itself', () => {
    expect(parse(['slack'])).toEqual({
      servers: {},
      broken: [],
      warnings: [],
      issues: [{ message: NOT_A_MAPPING, path: [] }],
    });
  });

  it(`defines at most ${MAX_SERVERS} servers`, () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SERVERS + 1 }, (_, i) => [`s${i}`, STDIO]),
    );
    const result = parse(many);
    expect(result.issues).toEqual([{ message: TOO_MANY, path: [] }]);
    expect(result.servers).toEqual({});
    expect(result.broken).toEqual(Object.keys(many));
    const twenty = Object.fromEntries(
      Array.from({ length: MAX_SERVERS }, (_, i) => [`s${i}`, STDIO]),
    );
    expect(Object.keys(parse(twenty).servers)).toHaveLength(MAX_SERVERS);
  });

  it.each([['Slack'], ['9slack'], ['slack_bot'], ['-slack'], [`s${'x'.repeat(64)}`]])(
    'refuses the name %s',
    (name) => {
      const result = parse({ [name]: STDIO });
      expect(result.issues).toEqual([{ message: NAME, path: [name] }]);
      expect(result.broken).toEqual([name]);
    },
  );

  it('takes a name of lowercase letters, digits and dashes', () => {
    for (const name of ['slack', 'tracker-2', `s${'x'.repeat(63)}`]) {
      expect(MCP_SERVER_NAME_PATTERN.test(name)).toBe(true);
    }
    expect(parse({ 'tracker-2': HTTP }).issues).toEqual([]);
  });

  it("keeps consola for Consola's own tools", () => {
    expect(parse({ consola: STDIO }).issues).toEqual([{ message: CONSOLA, path: ['consola'] }]);
  });

  it('refuses a server that is not a mapping', () => {
    for (const value of ['npx slack', null, ['npx'], 3]) {
      expect(issuesOf(value)).toEqual([{ message: NOT_A_SERVER, path: ['slack'] }]);
    }
  });

  it('keeps a broken server out of servers, names it in broken, and reads its siblings', () => {
    const result = parse({ slack: { ...STDIO, cwd: '/tmp' }, tracker: HTTP });
    expect(result.broken).toEqual(['slack']);
    expect(Object.keys(result.servers)).toEqual(['tracker']);
    expect(result.issues).toEqual([{ message: CWD, path: ['slack', 'cwd'] }]);
  });
});

describe('parseMcpServers: what is refused, each with its reason', () => {
  it.each([
    ['headersHelper', '/usr/local/bin/make-headers', HELPER],
    ['cwd', '/Users/alice/catalog-portal', CWD],
    ['oauth', { clientId: 'x' }, SIGN_IN],
    ['auth', 'bearer', SIGN_IN],
    ['timeout', 30, TIMEOUT],
    ['alwaysAllow', ['chat_post_message'], UNKNOWN('alwaysAllow')],
    ['environment', 'sandbox', UNKNOWN('environment')],
  ])('refuses %s at its key', (key, value, message) => {
    const result = one({ ...STDIO, [key]: value });
    expect(result.issues).toEqual([{ message, path: ['slack', key] }]);
    expect(result.broken).toEqual(['slack']);
  });

  it('refuses type:, whatever it says: the key written, command or url, says which kind a server is', () => {
    for (const [definition, type] of [
      [STDIO, 'stdio'],
      [HTTP, 'http'],
      [STDIO, 'http'],
      [HTTP, 'stdio'],
      [HTTP, 'streamable-http'],
      [HTTP, 3],
    ] as const) {
      expect(issuesOf({ ...definition, type }), String(type)).toEqual([
        { message: NO_TYPE, path: ['slack', 'type'] },
      ]);
    }
    expect(one({ ...HTTP, type: 'http' }).broken).toEqual(['slack']);
  });

  it('refuses type: sse, saying the transport is deprecated and where to point url', () => {
    expect(issuesOf({ ...HTTP, type: 'sse' })).toEqual([{ message: SSE, path: ['slack', 'type'] }]);
  });

  it('wants exactly one of command and url', () => {
    expect(issuesOf({ ...STDIO, ...HTTP })).toEqual([{ message: EXACTLY_ONE, path: ['slack'] }]);
    expect(issuesOf({ description: 'Nothing to start or call.' })).toEqual([
      { message: EXACTLY_ONE, path: ['slack'] },
    ]);
  });

  it('keeps headers to a remote server and args, env to one it starts', () => {
    expect(issuesOf({ ...STDIO, headers: { 'X-Team': 'sprocket' } })).toEqual([
      { message: FOR_HTTP, path: ['slack', 'headers'] },
    ]);
    expect(issuesOf({ ...HTTP, args: ['--verbose'] })).toEqual([
      { message: FOR_STDIO('args'), path: ['slack', 'args'] },
    ]);
    expect(issuesOf({ ...HTTP, env: { SLACK_TEAM_ID: 'T0SPROCKET' } })).toEqual([
      { message: FOR_STDIO('env'), path: ['slack', 'env'] },
    ]);
  });

  it('reads a description of one line, and refuses another', () => {
    expect(issuesOf({ ...STDIO, description: 'Posts as the support bot.' })).toEqual([]);
    expect(issuesOf({ ...STDIO, description: 'Posts.\nAs the bot.' })).toEqual([
      { message: '`description` is one line of text.', path: ['slack', 'description'] },
    ]);
  });
});

describe('parseMcpServers: a server Consola starts', () => {
  it.each([['./slack.js'], ['bin/slack'], ['../tools/slack-mcp']])(
    'refuses the relative command %s, naming it',
    (command) => {
      expect(issuesOf({ command })).toEqual([
        { message: RELATIVE(command), path: ['slack', 'command'] },
      ]);
    },
  );

  it('takes an absolute path and a bare name, found on PATH', () => {
    expect(issuesOf({ command: '/usr/local/bin/slack-mcp' })).toEqual([]);
    expect(issuesOf({ command: 'node' })).toEqual([]);
  });

  it('wants a command that is text', () => {
    for (const command of ['', 3, ['npx']]) {
      expect(issuesOf({ command })).toEqual([
        {
          message:
            'Expected `command` to be a program: a name on your `PATH`, or an absolute path.',
          path: ['slack', 'command'],
        },
      ]);
    }
  });

  it.each([['${TOKEN}'], ['--token=${SLACK_BOT_TOKEN}'], ['{{item.key}}'], ['x {{ steps.a.b }}']])(
    'refuses %s in args, at its index',
    (arg) => {
      expect(issuesOf({ command: 'npx', args: ['-y', arg] })).toEqual([
        { message: ARGS_TEMPLATE, path: ['slack', 'args', 1] },
      ]);
    },
  );

  it(`takes at most ${MAX_SERVER_ARGS} args`, () => {
    const args = (n: number) => Array.from({ length: n }, (_, i) => `--flag-${i}`);
    expect(issuesOf({ command: 'node', args: args(MAX_SERVER_ARGS) })).toEqual([]);
    expect(issuesOf({ command: 'node', args: args(MAX_SERVER_ARGS + 1) })).toEqual([
      { message: ARGS_COUNT, path: ['slack', 'args'] },
    ]);
  });

  it('wants args as a list of text', () => {
    expect(issuesOf({ command: 'node', args: '--verbose' })).toEqual([
      { message: 'Expected `args` to be a list of text.', path: ['slack', 'args'] },
    ]);
    expect(issuesOf({ command: 'node', args: ['--port', 8080] })).toEqual([
      {
        message: 'Expected text: write a number in quotes, e.g. "8080".',
        path: ['slack', 'args', 1],
      },
    ]);
  });

  it.each([
    [{ PATH: '/x' }, 'PATH', 'refused'],
    [{ LD_PRELOAD: '/tmp/x.dylib' }, 'LD_PRELOAD', 'refused'],
    [{ CONSOLA_X: 'y' }, 'CONSOLA_X', ENV_CONSOLA],
    [{ lower: 'y' }, 'lower', ENV_PATTERN],
  ])('holds env: names to env:’s rules (%j)', (env, name, message) => {
    const [issue] = issuesOf({ command: 'node', env });
    expect(issue.path).toEqual(['slack', 'env', name]);
    if (message === 'refused') {
      expect(issue.message).toMatch(
        new RegExp(
          `^\`${name}\` is refused: these names and prefixes are refused because they make a program run a value: BASH_ENV, `,
        ),
      );
      // A server has no run: to set it in, so the sentence says nothing of one.
      expect(issue.message).not.toContain('run:');
    } else expect(issue.message).toBe(message);
  });

  it('keeps a server’s env: literal', () => {
    for (const value of ['{{item.key}}', '${SLACK_BOT_TOKEN}', 'Bearer ${T}']) {
      expect(issuesOf({ command: 'node', env: { SLACK_TEAM: value } })).toEqual([
        { message: ENV_LITERAL, path: ['slack', 'env', 'SLACK_TEAM'] },
      ]);
    }
    expect(issuesOf({ command: 'node', env: { PORT: 8080 } })).toEqual([
      {
        message: 'Expected text: write a number in quotes, e.g. "8080".',
        path: ['slack', 'env', 'PORT'],
      },
    ]);
    expect(issuesOf({ command: 'node', env: ['SLACK_TEAM_ID=T0'] })).toEqual([
      { message: 'Expected `env` to be a mapping of NAME to text.', path: ['slack', 'env'] },
    ]);
  });

  it('refuses a credential written into env:, by its name and its value', () => {
    for (const name of [
      'API_TOKEN',
      'SLACK_SECRET',
      'DB_PASSWORD',
      'SPROCKET_API_KEY',
      'GCP_CREDENTIALS',
    ]) {
      expect(issuesOf({ command: 'node', env: { [name]: 'abcdefghijklmnop1234' } })).toEqual([
        { message: CREDENTIAL, path: ['slack', 'env', name] },
      ]);
    }
    // A short value, a value with spaces, or a name that is no credential's, passes.
    expect(issuesOf({ command: 'node', env: { MAX_TOKENS: '4096' } })).toEqual([]);
    expect(issuesOf({ command: 'node', env: { API_TOKEN: 'not a secret at all' } })).toEqual([]);
    expect(issuesOf({ command: 'node', env: { API_TOKEN: 'abcdefghijklmno' } })).toEqual([]);
    expect(issuesOf({ command: 'node', env: { SLACK_TEAM_ID: 'T0SPROCKET0123456789' } })).toEqual(
      [],
    );
  });

  it('takes secrets: by env:’s rules, and a name only once between env: and secrets:', () => {
    expect(issuesOf({ command: 'node', secrets: ['TOKEN'], env: { TOKEN: 'x' } })).toEqual([
      {
        message: '`TOKEN` is in both `env:` and `secrets:`; a value comes from one place.',
        path: ['slack', 'secrets', 0],
      },
    ]);
    expect(issuesOf({ command: 'node', secrets: ['PATH'] })[0].path).toEqual([
      'slack',
      'secrets',
      0,
    ]);
    expect(issuesOf({ command: 'node', secrets: 'SLACK_BOT_TOKEN' })).toEqual([
      {
        message: 'Expected `secrets` to be a list of names, e.g. `secrets: [PAGERDUTY_TOKEN]`.',
        path: ['slack', 'secrets'],
      },
    ]);
  });

  it('takes GH_TOKEN and GH_HOST in a server’s secrets: it never gets the bound account’s token', () => {
    const result = one({ command: 'node', secrets: ['GH_TOKEN', 'GH_HOST', 'GITHUB_TOKEN'] });
    expect(result.issues).toEqual([]);
    expect(result.servers.slack).toMatchObject({
      secrets: ['GH_TOKEN', 'GH_HOST', 'GITHUB_TOKEN'],
    });
    // A command still acts as the bound account (5a-1's rule, unchanged).
    expect(secretNameProblem('GH_TOKEN')).toBe(IDENTITY);
    expect(secretNameProblem('GH_TOKEN', 'command')).toBe(IDENTITY);
    expect(secretNameProblem('GH_TOKEN', 'server')).toBeNull();
    expect(secretNameProblem('GITHUB_TOKEN', 'server')).toBeNull();
    const fails: string[] = [];
    parseSecretNames(['GH_TOKEN'], (message) => fails.push(message));
    expect(fails).toEqual([IDENTITY]);
    // Every other rule holds on a server.
    expect(secretNameProblem('GH_ENTERPRISE_TOKEN', 'server')).toMatch(/is refused/);
    expect(secretNameProblem('CONSOLA_TOKEN', 'server')).toBe(ENV_CONSOLA);
    expect(secretNameProblem('CLAUDE_CONFIG_DIR', 'server')).toMatch(/harness's own/);
  });
});

describe('parseMcpServers: a server Consola calls', () => {
  it.each([
    ['http://127.0.0.1:8123/mcp'],
    ['http://localhost/mcp'],
    ['http://[::1]:9/mcp'],
    ['https://mcp.tracker.sprocket.example/mcp'],
  ])('takes %s', (url) => {
    expect(issuesOf({ url })).toEqual([]);
  });

  it.each([
    ['http://mcp.sprocket.example/mcp'],
    ['http://10.0.0.5/mcp'],
    ['ftp://mcp.sprocket.example/'],
    ['mcp.sprocket.example/mcp'],
    [''],
    [42],
  ])('refuses %s', (url) => {
    expect(issuesOf({ url })).toEqual([{ message: URL_WORDS, path: ['slack', 'url'] }]);
  });

  it('refuses ${…} in a url', () => {
    expect(issuesOf({ url: 'https://x.example/${T}', secrets: ['T'] })).toEqual([
      { message: URL_TEMPLATE, path: ['slack', 'url'] },
    ]);
  });

  it('takes ${NAME} in a header only for one of this server’s own secrets', () => {
    expect(
      issuesOf({
        ...HTTP,
        headers: { Authorization: 'Bearer ${TRACKER_TOKEN}' },
        secrets: ['TRACKER_TOKEN'],
      }),
    ).toEqual([]);
    // Another server's secret is not this one's.
    const result = parse({
      tracker: { ...HTTP, headers: { 'X-Token': '${OTHER}' }, secrets: ['TRACKER_TOKEN'] },
      other: { ...HTTP, headers: { 'X-Token': '${OTHER}' }, secrets: ['OTHER'] },
    });
    expect(result.issues).toEqual([
      { message: NOT_ONE_OF('OTHER'), path: ['tracker', 'headers', 'X-Token'] },
    ]);
    expect(Object.keys(result.servers)).toEqual(['other']);
  });

  it('refuses {{ }} in a header, and a line break', () => {
    expect(issuesOf({ ...HTTP, headers: { 'X-Item': '{{item.key}}' } })).toEqual([
      { message: HEADER_BRACES, path: ['slack', 'headers', 'X-Item'] },
    ]);
    for (const value of ['a\nb', 'a\r\nX-Other: b']) {
      expect(issuesOf({ ...HTTP, headers: { 'X-Team': value } })).toEqual([
        { message: ONE_LINE, path: ['slack', 'headers', 'X-Team'] },
      ]);
    }
  });

  it.each([
    ['Authorization', 'Bearer abc'],
    ['authorization', 'Basic YWxpY2U6eA=='],
    ['Cookie', 'a=b'],
    ['Proxy-Authorization', 'x'],
    ['X-Sprocket-Api-Key', 'k'],
    ['x-sprocket-api-key', 'k'],
  ])('refuses a literal %s header as a credential', (name, value) => {
    expect(issuesOf({ ...HTTP, headers: { [name]: value } })).toEqual([
      { message: CREDENTIAL, path: ['slack', 'headers', name] },
    ]);
  });

  it('takes a header with no credential in it, and refuses a name that is no header’s', () => {
    expect(issuesOf({ ...HTTP, headers: { 'X-Team': 'sprocket' } })).toEqual([]);
    expect(issuesOf({ ...HTTP, headers: { 'X Team': 'sprocket' } })).toEqual([
      { message: '`X Team` is not a header name.', path: ['slack', 'headers', 'X Team'] },
    ]);
    expect(issuesOf({ ...HTTP, headers: ['Authorization: x'] })).toEqual([
      {
        message: 'Expected `headers` to be a mapping of header name to text.',
        path: ['slack', 'headers'],
      },
    ]);
  });
});

describe('unpinnedLauncher, and the warning it gives', () => {
  it.each([
    ['npx', ['-y', '@sprocket/slack-mcp'], 'npx', 1],
    ['uvx', ['sprocket-slack'], 'uvx', 0],
    ['bunx', ['sprocket-slack@latest'], 'bunx', 0],
    ['pnpm', ['dlx', 'sprocket-slack'], 'pnpm dlx', 1],
    ['yarn', ['dlx', 'sprocket-slack@^1'], 'yarn dlx', 1],
    ['/usr/local/bin/npx', ['--yes', 'sprocket-slack@1.2'], 'npx', 1],
  ])('names %s %j unpinned, at the package', (command, args, launcher, at) => {
    expect(unpinnedLauncher(command, args)).toEqual({ launcher, at });
    const result = one({ command, args });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([{ message: UNPINNED, path: ['slack', 'args', at] }]);
    expect(Object.keys(result.servers)).toEqual(['slack']);
  });

  it.each([
    ['npx', ['-y', '@sprocket/slack-mcp@1.4.2']],
    ['npx', ['sprocket-slack@2.0.0-beta.3']],
    ['uvx', ['sprocket-slack==1.2.3']],
    ['bunx', ['sprocket-slack@0.9.1']],
    ['pnpm', ['dlx', 'sprocket-slack@3.1.4']],
    ['pnpm', ['exec', 'sprocket-slack']],
    ['/usr/local/bin/npx-like', ['sprocket-slack']],
    ['node', ['/opt/sprocket/slack.js']],
    ['npx', ['-y']],
  ])('gives no warning for %s %j', (command, args) => {
    expect(unpinnedLauncher(command, args)).toBeNull();
    expect(one({ command, args }).warnings).toEqual([]);
  });
});

describe('serverHash', () => {
  const definition = (over: Record<string, unknown> = {}) =>
    one({
      command: 'npx',
      args: ['-y', '@sprocket/slack-mcp@1.4.2'],
      env: { A: 'a', B: 'b' },
      secrets: ['SLACK_BOT_TOKEN'],
      ...over,
    }).servers.slack;

  it('is 16 hex characters, equal for equal definitions whatever order their keys were written in', () => {
    const hash = serverHash(definition());
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    const reordered = one(
      yaml(
        'secrets: [SLACK_BOT_TOKEN]\nenv: { B: b, A: a }\nargs: [-y, "@sprocket/slack-mcp@1.4.2"]\ncommand: npx\n',
      ),
    ).servers.slack;
    expect(serverHash(reordered)).toBe(hash);
  });

  it('moves with one character of args, an env value, a secret’s name and the description', () => {
    const hash = serverHash(definition());
    expect(serverHash(definition({ args: ['-y', '@sprocket/slack-mcp@1.4.3'] }))).not.toBe(hash);
    expect(serverHash(definition({ env: { A: 'a', B: 'c' } }))).not.toBe(hash);
    expect(serverHash(definition({ secrets: ['SLACK_TOKEN'] }))).not.toBe(hash);
    expect(serverHash(definition({ description: 'Posts as the support bot.' }))).not.toBe(hash);
  });
});
