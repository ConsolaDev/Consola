import type { SessionStart } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import {
  cellUrlProblem,
  END_CONFIRM_MS,
  EndedSessions,
  HostLineBuffer,
  harnessesFromEnv,
  MAX_ENDED_SESSIONS,
  MAX_ERROR_LENGTH,
  MAX_LINE_LENGTH,
  offerRefusal,
  RECONNECT_CAP_MS,
  readRepositories,
  reconnectDelayMs,
  SESSION_START_ARGV,
  SESSION_TEMPLATE,
  StderrTail,
  sandboxEnvFor,
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
        error: `clone failed with ghp_x ${'e'.repeat(MAX_ERROR_LENGTH * 2)}`,
      },
      ['ghp_x'],
    );
    expect(update.error).not.toContain('ghp_x');
    expect(update.error?.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(update.error?.startsWith('clone failed with [redacted]')).toBe(true);
  });

  it('leaves an update with no error as it is', () => {
    const update = { type: 'session.update' as const, sessionId: ID, title: 'ghp_x' };
    expect(scrubUpdate(update, ['ghp_x'])).toEqual(update);
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

  it('takes an end as received once its connection held for the confirm time', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 1, 1_000);
    expect(ends.forHello()).toEqual([]);
    ends.closed(1, 1_000 + END_CONFIRM_MS);
    expect(ends.forHello()).toEqual([]);
    expect(ends.size).toBe(0);
  });

  it('sends an end again when its connection closed too soon after it went out', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 1, 1_000);
    ends.closed(1, 1_000 + END_CONFIRM_MS - 1);
    expect(ends.forHello()).toEqual([stopped('a')]);
  });

  it('leaves alone ends sent on another connection', () => {
    const ends = new EndedSessions();
    ends.add(stopped('a'));
    ends.sent(['a'], 2, 1_000);
    ends.closed(1, 1_001);
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
