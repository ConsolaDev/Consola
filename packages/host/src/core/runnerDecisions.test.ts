import type { SessionStart } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import {
  cellUrlProblem,
  EndedSessions,
  HostLineBuffer,
  harnessesFromEnv,
  MAX_ENDED_SESSIONS,
  MAX_ERROR_LENGTH,
  MAX_LINE_LENGTH,
  offerRefusal,
  Pings,
  RECONNECT_CAP_MS,
  readRepositories,
  reconnectDelayMs,
  SANDBOX_LEASE_RENEW_SECONDS,
  SANDBOX_LEASE_SECONDS,
  SESSION_START_ARGV,
  SESSION_TEMPLATE,
  STDERR_TAIL_LENGTH,
  StderrTail,
  sandboxEnvFor,
  sandboxLifetimeSeconds,
  scrubSecrets,
  scrubUpdate,
  type SandboxEnd,
  updateForExit,
  updateForLine,
} from './runnerDecisions.ts';

const ID = 'session-sprocket-1';

describe('harnessesFromEnv', () => {
  it('offers claude for an Anthropic key', () => {
    expect(harnessesFromEnv({ ANTHROPIC_API_KEY: 'k' })).toEqual(['claude']);
  });

  it('offers codex for an OpenAI key', () => {
    expect(harnessesFromEnv({ OPENAI_API_KEY: 'k' })).toEqual(['codex']);
  });

  it('offers both for both keys, in the protocol order', () => {
    expect(harnessesFromEnv({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('offers nothing with no key, or an empty one', () => {
    expect(harnessesFromEnv({})).toEqual([]);
    expect(harnessesFromEnv({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: undefined })).toEqual([]);
  });
});

describe('readRepositories', () => {
  it('reads a comma-separated list of owner/name, trimming spaces', () => {
    expect(readRepositories('sprocket/catalog-portal, sprocket/acme.web')).toEqual({
      ok: true,
      repositories: ['sprocket/catalog-portal', 'sprocket/acme.web'],
    });
  });

  it('keeps each repository once', () => {
    expect(readRepositories('sprocket/a,sprocket/a')).toEqual({
      ok: true,
      repositories: ['sprocket/a'],
    });
  });

  it.each([
    ['nothing', undefined],
    ['an empty list', ' , '],
  ])('refuses %s', (_case, value) => {
    expect(readRepositories(value)).toMatchObject({ ok: false });
  });

  it.each(['sprocket', 'sprocket/..', 'sprocket/.git', 'https://github.com/sprocket/a'])(
    'refuses %s, naming it',
    (repository) => {
      const read = readRepositories(`sprocket/a,${repository}`);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.problem).toContain(repository);
    },
  );
});

describe('cellUrlProblem', () => {
  it.each([
    'wss://eu.cells.sprocket.test/api/runner',
    'ws://127.0.0.1:3101/api/runner',
    'ws://127.4.5.6/api/runner',
    'ws://localhost:3101/api/runner',
    'ws://[::1]:3101/api/runner',
  ])('takes %s', (url) => {
    expect(cellUrlProblem(url)).toBeNull();
  });

  it.each([
    ['ws: to a host that is not loopback', 'ws://eu.cells.sprocket.test/api/runner', /loopback/],
    ['ws: to a LAN address', 'ws://192.168.1.20:3101/api/runner', /loopback/],
    ['http:', 'https://eu.cells.sprocket.test/api/runner', /wss:/],
    ['no address at all', 'sprocket', /--cell-url/],
    ['user info', 'wss://runner:secret@eu.cells.sprocket.test/api/runner', /credentials/],
    ['a query', 'wss://eu.cells.sprocket.test/api/runner?token=sprocket', /query/],
    ['a fragment', 'wss://eu.cells.sprocket.test/api/runner#sprocket', /fragment/],
  ])('refuses %s', (_case, url, problem) => {
    expect(cellUrlProblem(url)).toMatch(problem);
  });

  it('never quotes user info it refuses', () => {
    expect(cellUrlProblem('wss://runner:s3cret@eu.cells.sprocket.test/x')).not.toContain('s3cret');
  });
});

describe('HostLineBuffer', () => {
  it('joins a line split across chunks', () => {
    const buffer = new HostLineBuffer();
    expect(buffer.push('{"type":"re')).toEqual([]);
    expect(buffer.push('ady","port":4100}\n')).toEqual(['{"type":"ready","port":4100}']);
  });

  it('splits two lines in one chunk', () => {
    const buffer = new HostLineBuffer();
    expect(buffer.push('{"type":"title","title":"a"}\n{"type":"exit","reason":"idle"}\n')).toEqual([
      '{"type":"title","title":"a"}',
      '{"type":"exit","reason":"idle"}',
    ]);
  });

  it('keeps an unfinished line for the next chunk, and drops empty lines and a carriage return', () => {
    const buffer = new HostLineBuffer();
    expect(buffer.push('\n\r\n{"type":"ready","port":1}\r\n{"type"')).toEqual([
      '{"type":"ready","port":1}',
    ]);
    expect(buffer.push(':"exit","reason":"idle"}\n')).toEqual(['{"type":"exit","reason":"idle"}']);
  });

  it('drops a line longer than it keeps, up to its end, and reads the next one', () => {
    const buffer = new HostLineBuffer();
    expect(buffer.push('x'.repeat(MAX_LINE_LENGTH))).toEqual([]);
    expect(buffer.push('more\n{"type":"ready","port":2}\n')).toEqual(['{"type":"ready","port":2}']);
  });
});

describe('updateForLine', () => {
  it('turns a title into a title update', () => {
    expect(updateForLine(ID, '{"type":"title","title":"Sprocket catalog"}')).toEqual({
      type: 'session.update',
      sessionId: ID,
      title: 'Sprocket catalog',
    });
  });

  it("turns the start script's clone-failed into a failure with its message", () => {
    expect(
      updateForLine(ID, '{"type":"exit","reason":"clone-failed","message":"Repository not found"}'),
    ).toEqual({
      type: 'session.update',
      sessionId: ID,
      status: 'failed',
      error: 'Repository not found',
    });
  });

  it.each([
    ['ready, which the runner answers once it has the address', '{"type":"ready","port":4100}'],
    ['a status', '{"type":"status","status":"working"}'],
    ['a dev pass', '{"type":"dev-pass","pass":"a.b.c","expiresInSeconds":43200}'],
    ["the host's own exit", '{"type":"exit","reason":"idle"}'],
    ['an empty title', '{"type":"title","title":""}'],
    ['an unknown line', '{"type":"hello"}'],
    ['a line that is not JSON', 'consola-host: warning'],
    ['a line that is not an object', '7'],
  ])('says nothing for %s', (_case, line) => {
    expect(updateForLine(ID, line)).toBeNull();
  });
});

describe('updateForExit', () => {
  const ended = (end: Partial<SandboxEnd>): SandboxEnd => ({
    exitCode: 0,
    sawExitLine: false,
    stoppedByRunner: false,
    lastStderrLine: null,
    ready: true,
    stopRequested: false,
    ...end,
  });

  it('is stopped for exit 0 after an exit line', () => {
    expect(updateForExit(ID, ended({ exitCode: 0, sawExitLine: true }))).toEqual({
      type: 'session.update',
      sessionId: ID,
      status: 'stopped',
    });
  });

  it('is failed with the last stderr line for a non-zero exit with no exit line', () => {
    expect(
      updateForExit(
        ID,
        ended({ exitCode: 1, lastStderrLine: 'consola-host: Cannot listen on 0.0.0.0:7420' }),
      ),
    ).toEqual({
      type: 'session.update',
      sessionId: ID,
      status: 'failed',
      error: 'consola-host: Cannot listen on 0.0.0.0:7420',
    });
  });

  it('names the exit code when a non-zero exit left nothing on stderr', () => {
    expect(updateForExit(ID, ended({ exitCode: 3 }))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('3'),
    });
  });

  it("is stopped when the sandbox ended after the runner's own stop", () => {
    expect(updateForExit(ID, ended({ exitCode: null, stoppedByRunner: true }))).toEqual({
      type: 'session.update',
      sessionId: ID,
      status: 'stopped',
    });
  });

  it('is failed, saying the sandbox ended, for any other end by a signal', () => {
    expect(updateForExit(ID, ended({ exitCode: null }))).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/sandbox ended/),
    });
  });

  it('is failed for exit 0 with no exit line: the host ends that way only when something else stopped it', () => {
    expect(updateForExit(ID, ended({ exitCode: 0 }))).toMatchObject({
      status: 'failed',
      error: expect.any(String),
    });
  });

  it('is stopped whenever the cell asked for the stop, ready or not', () => {
    for (const ready of [true, false]) {
      expect(
        updateForExit(
          ID,
          ended({ exitCode: null, stoppedByRunner: true, stopRequested: true, ready }),
        ),
      ).toMatchObject({ status: 'stopped' });
    }
  });

  it.each([
    ['exit 0 after an exit line', { exitCode: 0, sawExitLine: true }],
    ["a signal after the runner's own stop", { exitCode: null, stoppedByRunner: true }],
    ['a signal', { exitCode: null }],
    ['a non-zero exit', { exitCode: 1, lastStderrLine: 'fatal: Repository not found' }],
    ['exit 0', { exitCode: 0 }],
  ])(
    'is failed for an end before ready the cell did not ask for: %s',
    (_case, end: Partial<SandboxEnd>) => {
      const update = updateForExit(ID, ended({ ...end, ready: false }));
      expect(update.status).toBe('failed');
      expect(update.error).toEqual(expect.any(String));
    },
  );

  it('keeps the last stderr line when the host failed before it was ready', () => {
    expect(
      updateForExit(ID, ended({ exitCode: 1, ready: false, lastStderrLine: 'fatal: no repo' })),
    ).toMatchObject({ status: 'failed', error: 'fatal: no repo' });
  });
});

/** A token as GitHub writes them, and an API key: long enough that a piece of one gives it away. */
const GIT_TOKEN = 'ghp_sprocketGitTokenAbCdEf0123456789';
const API_KEY = 'sk-ant-api03-sprocketKeyZyXwVu9876543210';

/** No piece of `secret` eight characters or longer is in `text`. */
const expectNoPieceOf = (text: string, secret: string) => {
  for (let start = 0; start + 8 <= secret.length; start += 1) {
    expect(text).not.toContain(secret.slice(start, start + 8));
  }
};

describe('StderrTail', () => {
  it('answers the last line that holds text', () => {
    const tail = new StderrTail();
    tail.push('consola-host: warning: turns in /workspace/repo load…\n');
    tail.push('consola-host: Cannot listen');
    tail.push(' on 0.0.0.0:7420: EADDRINUSE.\n\n  \n');
    expect(tail.lastLine()).toBe('consola-host: Cannot listen on 0.0.0.0:7420: EADDRINUSE.');
  });

  it('answers null for nothing written', () => {
    expect(new StderrTail().lastLine()).toBeNull();
    const blank = new StderrTail();
    blank.push('\n  \n');
    expect(blank.lastLine()).toBeNull();
  });

  it('keeps a bounded tail, however much is written', () => {
    const tail = new StderrTail();
    for (let each = 0; each < 1_000; each += 1) tail.push(`${'x'.repeat(1_000)}\n`);
    tail.push(`${'y'.repeat(MAX_ERROR_LENGTH * 3)}\n`);
    const last = tail.lastLine() ?? '';
    expect(last.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(last.startsWith('y')).toBe(true);
  });

  it('takes a secret out of the line', () => {
    const tail = new StderrTail([GIT_TOKEN, API_KEY]);
    tail.push(`fatal: Authentication failed (${GIT_TOKEN}, ${API_KEY})\n`);
    expect(tail.lastLine()).toBe('fatal: Authentication failed ([redacted], [redacted])');
  });

  it('takes out a secret split across two chunks, wherever it is split', () => {
    for (let at = 1; at < GIT_TOKEN.length; at += 1) {
      const tail = new StderrTail([GIT_TOKEN]);
      tail.push(`fatal: token ${GIT_TOKEN.slice(0, at)}`);
      tail.push(`${GIT_TOKEN.slice(at)} refused\n`);
      expect(tail.lastLine()).toBe('fatal: token [redacted] refused');
    }
  });

  it('takes out a secret written one character at a time', () => {
    const tail = new StderrTail([GIT_TOKEN]);
    for (const character of `token=${GIT_TOKEN}\n`) tail.push(character);
    expect(tail.lastLine()).toBe('token=[redacted]');
  });

  it('leaves no piece of a secret that straddles the start of the tail it keeps', () => {
    for (const offset of [1, 8, GIT_TOKEN.length - 1]) {
      const tail = new StderrTail([GIT_TOKEN]);
      tail.push(`${GIT_TOKEN}${'y'.repeat(STDERR_TAIL_LENGTH - offset)}`);
      tail.push('\n');
      expectNoPieceOf(tail.lastLine() ?? '', GIT_TOKEN);
    }
  });

  it('leaves no piece of a secret that straddles the length an error is cut to', () => {
    for (const before of [MAX_ERROR_LENGTH - 8, MAX_ERROR_LENGTH - 1, MAX_ERROR_LENGTH - 20]) {
      const tail = new StderrTail([GIT_TOKEN]);
      tail.push(`${'e'.repeat(before)}${GIT_TOKEN} and more\n`);
      const last = tail.lastLine() ?? '';
      expect(last.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expectNoPieceOf(last, GIT_TOKEN);
    }
  });

  it('leaves no piece of a secret the output ended part-way through', () => {
    const tail = new StderrTail([GIT_TOKEN]);
    tail.push(`fatal: token ${GIT_TOKEN.slice(0, 20)}`);
    const last = tail.lastLine() ?? '';
    expect(last.startsWith('fatal: token')).toBe(true);
    expectNoPieceOf(last, GIT_TOKEN);
  });
});

describe('scrubSecrets', () => {
  const TOKEN = 'ghp_sprocketToken123';

  it('takes every secret out of the text', () => {
    expect(
      scrubSecrets(`git: auth failed for ${TOKEN} (key sk-ant-1); ${TOKEN}`, [TOKEN, 'sk-ant-1']),
    ).toBe('git: auth failed for [redacted] (key [redacted]); [redacted]');
  });

  it('takes out a secret written URL-encoded', () => {
    const secret = 'a/b+c=d';
    expect(scrubSecrets(`https://x:${encodeURIComponent(secret)}@github.com`, [secret])).toBe(
      'https://x:[redacted]@github.com',
    );
  });

  it('takes out the longer of two secrets that overlap whole', () => {
    expect(scrubSecrets('abcdef', ['abc', 'abcdef'])).toBe('[redacted]');
  });

  it('ignores empty secrets', () => {
    expect(scrubSecrets('Repository not found', ['', 'zzz'])).toBe('Repository not found');
  });
});

describe('scrubUpdate', () => {
  it('takes secrets out of the error and bounds its length', () => {
    const update = scrubUpdate(
      {
        type: 'session.update',
        sessionId: ID,
        status: 'failed',
        error: `clone failed with ${GIT_TOKEN} ${'e'.repeat(MAX_ERROR_LENGTH * 2)}`,
      },
      [GIT_TOKEN],
    );
    expectNoPieceOf(update.error ?? '', GIT_TOKEN);
    expect(update.error?.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(update.error?.startsWith('clone failed with [redacted]')).toBe(true);
  });

  it('takes secrets out of the title: it is made from the conversation, which may hold one', () => {
    expect(
      scrubUpdate(
        { type: 'session.update', sessionId: ID, title: `Use ${GIT_TOKEN} and ${API_KEY}` },
        [GIT_TOKEN, API_KEY],
      ),
    ).toEqual({ type: 'session.update', sessionId: ID, title: 'Use [redacted] and [redacted]' });
  });

  it.each([
    ['error', MAX_ERROR_LENGTH - 8],
    ['error', MAX_ERROR_LENGTH - 1],
    ['title', MAX_ERROR_LENGTH - 8],
    ['title', MAX_ERROR_LENGTH - 1],
  ] as const)(
    'leaves no piece of a secret that straddles the length a %s is cut to (%i before it)',
    (field, before) => {
      const update = scrubUpdate(
        {
          type: 'session.update',
          sessionId: ID,
          [field]: `${'e'.repeat(before)}${GIT_TOKEN} tail`,
        },
        [GIT_TOKEN],
      );
      const said = update[field] ?? '';
      expect(said.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
      expectNoPieceOf(said, GIT_TOKEN);
    },
  );

  it('leaves an update with neither an error nor a title as it is', () => {
    const update = {
      type: 'session.update' as const,
      sessionId: ID,
      status: 'running' as const,
      hostUrl: 'https://4100-sprocket.e2b.app',
    };
    expect(scrubUpdate(update, [GIT_TOKEN])).toEqual(update);
  });
});

describe('offerRefusal', () => {
  const offer = { repositories: ['sprocket/catalog-portal'], harnesses: ['claude' as const] };

  it('takes a repository and a harness the runner offers', () => {
    expect(
      offerRefusal(offer, { repository: 'sprocket/catalog-portal', harness: 'claude' }),
    ).toBeNull();
  });

  it('refuses a repository it does not offer, naming it', () => {
    expect(offerRefusal(offer, { repository: 'sprocket/other', harness: 'claude' })).toMatch(
      /sprocket\/other/,
    );
  });

  it('refuses a harness it does not offer, naming it', () => {
    expect(
      offerRefusal(offer, { repository: 'sprocket/catalog-portal', harness: 'codex' }),
    ).toMatch(/codex/);
  });
});

describe('sandboxEnvFor', () => {
  const start = (harness: SessionStart['harness']): SessionStart => ({
    type: 'session.start',
    sessionId: ID,
    workspaceId: 'ws-sprocket',
    repository: 'sprocket/catalog-portal',
    harness,
    passPublicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n',
  });
  const secrets = {
    gitToken: 'ghp_sprocket',
    apiKeys: { claude: 'sk-ant-sprocket', codex: 'sk-openai-sprocket' },
  };

  it('gives a claude session its variables and the Anthropic key only', () => {
    expect(sandboxEnvFor(start('claude'), secrets, 10)).toEqual({
      CONSOLA_SESSION_ID: ID,
      CONSOLA_HARNESS: 'claude',
      CONSOLA_REPOSITORY: 'sprocket/catalog-portal',
      CONSOLA_PASS_PUBLIC_KEY: start('claude').passPublicKeyPem,
      CONSOLA_SESSION_IDLE_MINUTES: '10',
      GIT_TOKEN: 'ghp_sprocket',
      ANTHROPIC_API_KEY: 'sk-ant-sprocket',
    });
  });

  it('gives a codex session the OpenAI key only', () => {
    const env = sandboxEnvFor(start('codex'), secrets, 2.5);
    expect(env.OPENAI_API_KEY).toBe('sk-openai-sprocket');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.CONSOLA_SESSION_IDLE_MINUTES).toBe('2.5');
  });

  it('gives no git token when the runner has none', () => {
    expect(
      sandboxEnvFor(start('claude'), { ...secrets, gitToken: undefined }, 10),
    ).not.toHaveProperty('GIT_TOKEN');
  });

  it('names the session template and its start command', () => {
    expect(SESSION_TEMPLATE).toBe('consola-session');
    expect(SESSION_START_ARGV).toEqual(['consola-session-start']);
  });
});

describe('sandboxLifetimeSeconds', () => {
  it('leases a sandbox for ten minutes at a time, renewed every three', () => {
    expect(SANDBOX_LEASE_SECONDS).toBe(600);
    expect(SANDBOX_LEASE_RENEW_SECONDS).toBe(180);
    expect(sandboxLifetimeSeconds(8 * 3_600_000, SANDBOX_LEASE_SECONDS)).toBe(600);
  });

  it('never runs past the cap: what is left of it, in whole seconds, once that is shorter', () => {
    expect(sandboxLifetimeSeconds(599_999, 600)).toBe(599);
    expect(sandboxLifetimeSeconds(90_500, 600)).toBe(90);
    expect(sandboxLifetimeSeconds(1_000, 600)).toBe(1);
  });

  it('is the whole of what is left of the cap without a lease', () => {
    expect(sandboxLifetimeSeconds(8 * 3_600_000, null)).toBe(28_800);
    expect(sandboxLifetimeSeconds(28_800_999, null)).toBe(28_800);
  });

  it('is a second at least, the grain a provider takes, when the cap is less than one away', () => {
    expect(sandboxLifetimeSeconds(300, 600)).toBe(1);
    expect(sandboxLifetimeSeconds(0, null)).toBe(1);
    expect(sandboxLifetimeSeconds(-5_000, 600)).toBe(1);
  });
});

describe('reconnectDelayMs', () => {
  it('grows with each failure and stays within half to all of its step', () => {
    expect(reconnectDelayMs(0, 0)).toBe(250);
    expect(reconnectDelayMs(0, 0.999_999)).toBeCloseTo(500, 0);
    expect(reconnectDelayMs(3, 0)).toBe(2_000);
  });

  it('is capped at 30 seconds', () => {
    expect(RECONNECT_CAP_MS).toBe(30_000);
    expect(reconnectDelayMs(50, 0.999_999)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelayMs(50, 0)).toBe(15_000);
  });
});

describe('EndedSessions', () => {
  const stopped = (sessionId: string) => ({ sessionId, status: 'stopped' as const });

  it('keeps an end for the next hello until it is sent', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.add({ sessionId: 'b', status: 'failed', error: 'Repository not found' });
    expect(ends.forHello()).toEqual([
      stopped('a'),
      { sessionId: 'b', status: 'failed', error: 'Repository not found' },
    ]);
  });

  it('takes an end as heard once the pong of the ping that followed it comes back', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 1, 3);
    expect(ends.forHello()).toEqual([]);
    ends.heard(1, 2);
    expect(ends.size).toBe(1);
    ends.heard(1, 3);
    expect(ends.size).toBe(0);
    ends.closed(1);
    expect(ends.forHello()).toEqual([]);
  });

  it('sends an end again when its connection closed before its ping was answered, however long it was open', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 1, 1);
    ends.closed(1);
    expect(ends.forHello()).toEqual([stopped('a')]);
  });

  it('leaves alone ends sent on another connection', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 2, 1);
    ends.heard(1, 5);
    ends.closed(1);
    expect(ends.forHello()).toEqual([]);
    expect(ends.size).toBe(1);
  });

  it('keeps one end per session, the latest', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.add({ sessionId: 'a', status: 'failed', error: 'late' });
    expect(ends.forHello()).toEqual([{ sessionId: 'a', status: 'failed', error: 'late' }]);
  });

  it('holds a bounded number, dropping the oldest', () => {
    const ends = new EndedSessions();
    for (let each = 0; each <= MAX_ENDED_SESSIONS; each += 1) ends.add(stopped(`s-${each}`));
    const held = ends.forHello();
    expect(held).toHaveLength(MAX_ENDED_SESSIONS);
    expect(held[0]?.sessionId).toBe('s-1');
  });
});

describe('Pings', () => {
  const timing = { intervalMs: 100, timeoutMs: 50 };

  it('numbers its pings from 1, and pings again an interval after the last', () => {
    const pings = new Pings(0, timing);
    expect(pings.step(0)).toEqual({ kind: 'wait', ms: 100 });
    expect(pings.step(100)).toEqual({ kind: 'ping' });
    expect(pings.next(100)).toBe(1);
    expect(pings.answer('1')).toBe(1);
    expect(pings.step(150)).toEqual({ kind: 'wait', ms: 50 });
    expect(pings.next(200)).toBe(2);
  });

  it('drops the socket once a ping has gone unanswered for the timeout', () => {
    const pings = new Pings(0, timing);
    pings.next(0);
    expect(pings.step(49)).toEqual({ kind: 'wait', ms: 1 });
    expect(pings.step(50)).toEqual({ kind: 'drop' });
  });

  it('counts the timeout from the oldest ping not answered', () => {
    const pings = new Pings(0, timing);
    pings.next(0);
    pings.next(40);
    expect(pings.answer('1')).toBe(1);
    expect(pings.step(60)).toEqual({ kind: 'wait', ms: 30 });
    expect(pings.step(90)).toEqual({ kind: 'drop' });
  });

  it('takes an answer to a ping as answering every ping before it', () => {
    const pings = new Pings(0, timing);
    pings.next(0);
    pings.next(10);
    expect(pings.answer('2')).toBe(2);
    expect(pings.answer('1')).toBeNull();
    expect(pings.step(60)).toEqual({ kind: 'wait', ms: 50 });
  });

  it.each(['', '0', '01', '3', '1.0', ' 1', 'x', '9'.repeat(20)])(
    'ignores a pong carrying %j, which names no ping it is waiting on',
    (payload) => {
      const pings = new Pings(0, timing);
      pings.next(0);
      pings.next(1);
      expect(pings.answer(payload)).toBeNull();
      expect(pings.step(50)).toEqual({ kind: 'drop' });
    },
  );
});
