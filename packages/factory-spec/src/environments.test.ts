import { describe, expect, it } from 'vitest';
import {
  environmentHash,
  looksLikeCredential,
  MAX_ENVIRONMENT_ENTRIES,
  parseEnvironmentFile,
} from './environments';

/*
 * `environments/<name>.yaml` (slice 3-B): where a write agent runs, `host`
 * (a convention) or `sandbox` (the CLI's own), what a sandboxed step may
 * reach and which variables of the person's environment it gets. A name an
 * environment would pass that runs a program, or is Consola's or the
 * harness's own, is refused, and so, until commands run in an environment
 * (3-C), is one that looks like a credential.
 */

const messages = (text: string, name = 'e') =>
  parseEnvironmentFile(name, text).issues.map((issue) => issue.message);

describe('parseEnvironmentFile', () => {
  it('reads a sandbox and a host', () => {
    expect(
      parseEnvironmentFile(
        'sandboxed',
        'isolation: sandbox\nnetwork: [registry.npmjs.org, "*.githubusercontent.com"]\nenv: [NODE_ENV, CI]\n',
      ).environment,
    ).toMatchObject({
      name: 'sandboxed',
      isolation: 'sandbox',
      network: ['registry.npmjs.org', '*.githubusercontent.com'],
      env: ['NODE_ENV', 'CI'],
    });
    expect(parseEnvironmentFile('my-machine', 'isolation: host\n').environment).toMatchObject({
      isolation: 'host',
      network: [],
      env: [],
    });
  });

  it('keeps a one-line description, and leaves it out when not written', () => {
    const described = parseEnvironmentFile(
      'e',
      'isolation: sandbox\ndescription: The registry only.\n',
    ).environment;
    expect(described?.description).toBe('The registry only.');
    const plain = parseEnvironmentFile('e', 'isolation: sandbox\n').environment!;
    expect(Object.prototype.hasOwnProperty.call(plain, 'description')).toBe(false);
  });

  it.each([
    ['', '`isolation:` is `host` or `sandbox`.'],
    ['isolation: container', '`isolation: container` arrives with the headless runner (slice 7).'],
    ['isolation: sandbox\nimage: node:26', '`image` arrives with the headless runner (slice 7).'],
    ['isolation: sandbox\nsecrets: [x]', '`secrets` arrives with connections as data (slice 5).'],
    [
      'isolation: host\nnetwork: [a.com]',
      'On `host` a step has your whole network and environment',
    ],
    ['isolation: host\nenv: [CI]', 'On `host` a step has your whole network and environment'],
    ['isolation: sandbox\nnetwork: ["https://a.com"]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: ["*"]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: [1.1.1.1]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: ["a.com:443"]', 'is not a host name'],
    ['isolation: sandbox\nenv: [node_env]', '`node_env` is not a variable name'],
    ['isolation: sandbox\nenv: [NODE_OPTIONS]', '`NODE_OPTIONS` makes a program run its value'],
    ['isolation: sandbox\nenv: [CONSOLA_RUN_ID]', "is Consola's or the harness's own"],
    ['isolation: sandbox\nenv: [CLAUDE_CONFIG_DIR]', "is Consola's or the harness's own"],
    [
      'isolation: sandbox\nenv: [NPM_TOKEN]',
      '`NPM_TOKEN` looks like a credential, which an environment passes to its commands only, and no command runs in an environment yet.',
    ],
    ...['DATABASE_URL', 'GITLAB_PAT', 'REGISTRY_AUTH', 'SMTP_PASS'].map((n): [string, string] => [
      `isolation: sandbox\nenv: [${n}]`,
      `\`${n}\` looks like a credential`,
    ]),
    ['isolation: sandbox\nfoo: 1', 'Unrecognized key in an environment: `foo`.'],
    // Beyond the plan's rows.
    ['isolation: sandbox\nsetup: npm ci', '`setup` arrives with the headless runner (slice 7).'],
    ['isolation: host\nnetwork: []', 'On `host` a step has your whole network and environment'],
    ['isolation: sandbox\nnetwork: [localhost]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: ["*.com"]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: ["[::1]"]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: ["a..b.com"]', 'is not a host name'],
    ['isolation: sandbox\nnetwork: [7]', 'is not a host name'],
    [
      `isolation: sandbox\nnetwork: [${Array.from({ length: 5 }, () => 'a'.repeat(60)).join('.')}.com]`,
      'is not a host name',
    ],
    [`isolation: sandbox\nnetwork: [${'a'.repeat(64)}.com]`, 'is not a host name'],
    ['isolation: sandbox\nnetwork: registry.npmjs.org', '`network:` is a list'],
    ['isolation: sandbox\nenv: CI', '`env:` is a list'],
    ['isolation: sandbox\nenv: [PATH]', '`PATH` makes a program run its value'],
    ['isolation: sandbox\nenv: [GIT_DIR]', '`GIT_DIR` makes a program run its value'],
    ['isolation: sandbox\nenv: [GH_TOKEN]', '`GH_TOKEN` looks like a credential'],
    ['isolation: sandbox\nenv: [CI, CI]', '`CI` is listed twice in `env:`.'],
    ['isolation: sandbox\nnetwork: [a.com, A.com]', '`A.com` is listed twice in `network:`.'],
    ['isolation: sandbox\ndescription: "two\\nlines"', '`description:` is one line of text.'],
    ['isolation: sandbox\ndescription: 7', '`description:` is one line of text.'],
    ['isolation: [sandbox]', '`isolation:` is `host` or `sandbox`.'],
    ['- isolation: sandbox', 'An environment file holds keys, e.g. `isolation: sandbox`.'],
  ])('refuses %j', (text, words) =>
    expect(messages(text)).toContainEqual(expect.stringContaining(words)),
  );

  it(`lists at most ${MAX_ENVIRONMENT_ENTRIES} hosts and names`, () => {
    const hosts = Array.from({ length: 51 }, (_, i) => `h${i}.example.com`).join(', ');
    const names = Array.from({ length: 51 }, (_, i) => `V${i}`).join(', ');
    expect(messages(`isolation: sandbox\nnetwork: [${hosts}]\n`)).toContain(
      '`network` lists at most 50 entries.',
    );
    expect(messages(`isolation: sandbox\nenv: [${names}]\n`)).toContain(
      '`env` lists at most 50 entries.',
    );
    const fifty = Array.from({ length: 50 }, (_, i) => `h${i}.example.com`).join(', ');
    expect(messages(`isolation: sandbox\nnetwork: [${fifty}]\n`)).toEqual([]);
  });

  it('takes NODE_ENV and CI, the data the spec names, and gives no environment with any problem', () => {
    expect(messages('isolation: sandbox\nenv: [NODE_ENV, CI, LANG_HINT]\n')).toEqual([]);
    expect(
      parseEnvironmentFile('e', 'isolation: sandbox\nenv: [NODE_ENV, NPM_TOKEN]\n').environment,
    ).toBeUndefined();
  });

  it('points each issue at its file, key and line', () => {
    expect(
      parseEnvironmentFile('sandboxed', 'isolation: sandbox\nenv:\n  - CI\n  - NODE_OPTIONS\n')
        .issues,
    ).toEqual([
      {
        message:
          '`NODE_OPTIONS` makes a program run its value, so an environment does not pass it.',
        file: 'environments/sandboxed.yaml',
        path: 'env[1]',
        line: 4,
      },
    ]);
    expect(parseEnvironmentFile('e', 'isolation: [\n').issues[0]).toMatchObject({
      file: 'environments/e.yaml',
    });
  });

  it('says the fixed words for a host it refuses, a credential and a stray key', () => {
    expect(messages('isolation: sandbox\nnetwork: ["https://a.com"]\n')).toEqual([
      '`https://a.com` is not a host name: write a name (`registry.npmjs.org`) or `*.` and a name (`*.githubusercontent.com`), no scheme, port or address.',
    ]);
    expect(messages('isolation: host\nnetwork: [a.com]\n')).toEqual([
      'On `host` a step has your whole network and environment; a list here would not be enforced. Use `isolation: sandbox` to limit them.',
    ]);
    expect(messages('isolation: sandbox\nenv: [CONSOLA_RUN_ID]\n')).toEqual([
      "`CONSOLA_RUN_ID` is Consola's or the harness's own; an environment does not pass it.",
    ]);
  });

  it('one byte changes its hash', () =>
    expect(parseEnvironmentFile('e', 'isolation: sandbox\nenv: [CI]\n').environment!.hash).not.toBe(
      parseEnvironmentFile('e', 'isolation: sandbox\nenv: [CI, NODE_ENV]\n').environment!.hash,
    ));

  it('hashes what the file says, not its name or its spelling', () => {
    const a = parseEnvironmentFile('a', 'isolation: sandbox\nenv: [CI]\n').environment!;
    const b = parseEnvironmentFile('b', '# a comment\nenv:\n  - CI\nisolation: sandbox\n')
      .environment!;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(environmentHash({ isolation: 'sandbox', network: [], env: ['CI'] }));
    for (const other of [
      { isolation: 'host' as const, network: [], env: [] },
      { isolation: 'sandbox' as const, network: ['a.com'], env: ['CI'] },
      { isolation: 'sandbox' as const, network: [], env: ['CI'], description: 'x' },
    ])
      expect(environmentHash(other)).not.toBe(a.hash);
  });
});

describe('looksLikeCredential (review M4)', () => {
  it.each([
    'NPM_TOKEN',
    'GH_TOKEN',
    'TOKEN',
    'MY_SECRET_VALUE',
    'DB_PASSWORD',
    'SMTP_PASSWD',
    'AWS_CREDENTIALS',
    'STRIPE_KEY',
    'GITLAB_PAT',
    'REGISTRY_AUTH',
    'SMTP_PASS',
    'DATABASE_URL',
    'READ_DATABASE_URL',
  ])('takes %s for a credential', (name) => expect(looksLikeCredential(name)).toBe(true));

  it.each(['NODE_ENV', 'CI', 'KEYBOARD', 'PASSAGE', 'AUTHOR', 'DATABASE', 'PATH_URL'])(
    'does not take %s for one',
    (name) => expect(looksLikeCredential(name)).toBe(false),
  );
});
