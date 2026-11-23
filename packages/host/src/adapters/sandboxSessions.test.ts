import type { Harness, SessionStart, SessionUpdate } from '@consola/runner-protocol';
import {
  type FakeProcess,
  FakeProvider,
  type FakeProviderOptions,
  SandboxError,
  type SandboxProvider,
  sandboxesFrom,
} from '@consola/sandbox';
import type * as Cause from 'effect/Cause';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import { describe, expect, it } from 'vite-plus/test';
import { type SandboxSessions, makeSandboxSessions } from './sandboxSessions.ts';

const GIT_TOKEN = 'ghp_sprocketGitToken0123';
const ANTHROPIC_KEY = 'sk-ant-sprocket-0123';
const OPENAI_KEY = 'sk-openai-sprocket-0123';
const SECRETS = { gitToken: GIT_TOKEN, apiKeys: { claude: ANTHROPIC_KEY, codex: OPENAI_KEY } };
const SECRET_VALUES = [GIT_TOKEN, ANTHROPIC_KEY, OPENAI_KEY];
const REPOSITORY = 'sprocket/catalog-portal';
const OFFER = { repositories: [REPOSITORY], harnesses: ['claude', 'codex'] as Harness[] };
const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAsprocket\n-----END PUBLIC KEY-----\n';

const startOf = (
  sessionId: string,
  { harness = 'claude', repository = REPOSITORY }: { harness?: Harness; repository?: string } = {},
): SessionStart => ({
  type: 'session.start',
  sessionId,
  workspaceId: 'ws-sprocket',
  repository,
  harness,
  passPublicKeyPem: PEM,
});

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** A start script that says `ready` on `port` and runs until its sandbox stops. */
const readyUntilStopped =
  (port = 4100) =>
  async (child: FakeProcess) => {
    child.stdout(line({ type: 'ready', port }));
    await child.killed;
  };

type Harnessed = {
  readonly fake: FakeProvider;
  readonly sessions: SandboxSessions;
  /** The next update the sessions sent the cell; dies when none comes in time. */
  readonly next: Effect.Effect<SessionUpdate>;
  /** Every update sent so far. */
  readonly sent: ReadonlyArray<SessionUpdate>;
  /** Every line logged so far. */
  readonly logged: ReadonlyArray<string>;
};

const UPDATE_TIMEOUT = Duration.seconds(10);

/** Sessions over a fake provider with `programs`, reporting into a queue a test reads. */
const harness = Effect.fn('harness')(function* (
  options: {
    readonly fake?: FakeProviderOptions;
    readonly provider?: (fake: FakeProvider) => SandboxProvider;
    readonly maxLifetime?: Duration.Input;
    readonly exitLineGrace?: Duration.Input;
    readonly offer?: { readonly repositories: string[]; readonly harnesses: Harness[] };
  } = {},
) {
  const fake = new FakeProvider({ templates: { 'consola-session': {} }, ...options.fake });
  const updates = yield* Queue.unbounded<SessionUpdate, Cause.Done>();
  const sent: SessionUpdate[] = [];
  const logged: string[] = [];
  const sessions = yield* makeSandboxSessions({
    sandboxes: sandboxesFrom(options.provider?.(fake) ?? fake),
    offer: options.offer ?? OFFER,
    secrets: SECRETS,
    secretValues: SECRET_VALUES,
    idleMinutes: 10,
    maxLifetime: options.maxLifetime ?? Duration.hours(8),
    exitLineGrace: options.exitLineGrace ?? Duration.seconds(30),
    report: (update) =>
      Effect.sync(() => {
        sent.push(update);
        Queue.offerUnsafe(updates, update);
      }),
    log: (message) => Effect.sync(() => logged.push(message)),
  });
  const harnessed: Harnessed = {
    fake,
    sessions,
    next: Queue.take(updates).pipe(
      Effect.timeoutOrElse({
        duration: UPDATE_TIMEOUT,
        orElse: () => Effect.die(new Error(`no update in time; sent ${JSON.stringify(sent)}`)),
      }),
      Effect.orDie,
    ),
    sent,
    logged,
  };
  return harnessed;
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Nothing secret was sent to the cell or logged. */
const expectNoSecret = (h: Harnessed) => {
  const said = JSON.stringify({ sent: h.sent, logged: h.logged });
  for (const secret of SECRET_VALUES) expect(said).not.toContain(secret);
};

const finalsOf = (sent: ReadonlyArray<SessionUpdate>, sessionId: string) =>
  sent.filter(
    (update) =>
      update.sessionId === sessionId && (update.status === 'stopped' || update.status === 'failed'),
  );

describe('makeSandboxSessions', () => {
  it("creates the sandbox from the session template with the session's variables and its harness's key alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-1'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        const [sandbox] = h.fake.sandboxes;
        expect(sandbox?.template).toBe('consola-session');
        expect(sandbox?.env).toEqual({
          CONSOLA_SESSION_ID: 'session-acme-1',
          CONSOLA_HARNESS: 'claude',
          CONSOLA_REPOSITORY: REPOSITORY,
          CONSOLA_PASS_PUBLIC_KEY: PEM,
          CONSOLA_SESSION_IDLE_MINUTES: '10',
          GIT_TOKEN,
          ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        });
        expect(sandbox?.env).not.toHaveProperty('OPENAI_API_KEY');
        expect(sandbox?.commands.map((command) => command.argv)).toEqual([
          ['consola-session-start'],
        ]);
        yield* h.sessions.stopAll;
        expectNoSecret(h);
      }),
    ));

  it('gives a codex session the OpenAI key and not the Anthropic one', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-codex', { harness: 'codex' }));
        yield* h.next;
        const env = h.fake.sandboxes[0]?.env ?? {};
        expect(env.OPENAI_API_KEY).toBe(OPENAI_KEY);
        expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
        yield* h.sessions.stopAll;
      }),
    ));

  it('exposes the port ready names, not a fixed one, and says the session runs at its address', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped(4100) } },
        });
        yield* h.sessions.start(startOf('session-acme-2'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-2',
          status: 'running',
          hostUrl: 'https://4100-fake-1.fake-sandbox.test',
        });
        expect(h.fake.sandboxes[0]?.exposedPorts).toEqual([4100]);
        yield* h.sessions.stopAll;
      }),
    ));

  it('turns a title line into a title update, however the output is split', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                const printed = `${line({ type: 'ready', port: 4100 })}${line({ type: 'status', status: 'working' })}${line({ type: 'title', title: 'Sprocket catalog' })}`;
                child.stdout(printed.slice(0, 20));
                child.stdout(printed.slice(20, 61));
                child.stdout(printed.slice(61));
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-3'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-3',
          title: 'Sprocket catalog',
        });
        expect(yield* h.sessions.live).toEqual({
          sessionIds: ['session-acme-3'],
          states: [
            {
              type: 'session.update',
              sessionId: 'session-acme-3',
              status: 'running',
              hostUrl: 'https://4100-fake-1.fake-sandbox.test',
              title: 'Sprocket catalog',
            },
          ],
        });
        yield* h.sessions.stopAll;
      }),
    ));

  it('takes the secrets out of a title before the cell hears it', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                child.stdout(line({ type: 'ready', port: 4100 }));
                child.stdout(
                  line({ type: 'title', title: `Push with ${GIT_TOKEN} (${OPENAI_KEY})` }),
                );
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-title'));
        yield* h.next;
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-title',
          title: 'Push with [redacted] ([redacted])',
        });
        expect((yield* h.sessions.live).states[0]?.title).toBe('Push with [redacted] ([redacted])');
        yield* h.sessions.stopAll;
        expectNoSecret(h);
      }),
    ));

  it('stops the sandbox when the host ends after its exit line, and says stopped once', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': (child) => {
                child.stdout(line({ type: 'ready', port: 4100 }));
                child.stdout(line({ type: 'exit', reason: 'idle' }));
                return 0;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-4'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-4',
          status: 'stopped',
        });
        yield* h.sessions.stopAll;
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expect(finalsOf(h.sent, 'session-acme-4')).toHaveLength(1);
        expect((yield* h.sessions.live).sessionIds).toEqual([]);
      }),
    ));

  it("stops a sandbox whose host printed its exit line and did not end, after the exit line's grace", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          exitLineGrace: Duration.millis(200),
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                child.stdout(line({ type: 'ready', port: 4100 }));
                child.stdout(line({ type: 'exit', reason: 'idle' }));
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-5'));
        yield* h.next;
        expect(yield* h.next).toMatchObject({ status: 'stopped' });
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
      }),
    ));

  it.each([
    [
      'the provider refuses to create it',
      { failCreate: () => 'E2B: the sandbox quota for this team is used up' },
      'E2B: the sandbox quota for this team is used up',
    ],
    [
      'the session template is missing',
      { templates: { base: {} } },
      'There is no template named consola-session.',
    ],
  ])("is failed with the provider's message when %s", (_case, fake, message) =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ fake });
        yield* h.sessions.start(startOf('session-acme-6'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-6',
          status: 'failed',
          error: message,
        });
        expect(h.fake.sandboxes).toHaveLength(0);
        expect((yield* h.sessions.live).sessionIds).toEqual([]);
      }),
    ),
  );

  it("takes the git token and the API keys out of a failure's message before the cell hears it", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            failCreate: () =>
              `cannot clone https://x-access-token:${GIT_TOKEN}@github.com/${REPOSITORY} (${ANTHROPIC_KEY})`,
          },
        });
        yield* h.sessions.start(startOf('session-acme-7'));
        const failed = yield* h.next;
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe(
          `cannot clone https://x-access-token:[redacted]@github.com/${REPOSITORY} ([redacted])`,
        );
        expectNoSecret(h);
      }),
    ));

  it("is failed with the start script's message when the clone fails, once", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': (child) => {
                child.stderr(`fatal: could not read from https://github.com (${GIT_TOKEN})\n`);
                child.stdout(
                  line({ type: 'exit', reason: 'clone-failed', message: 'Repository not found' }),
                );
                return 1;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-8'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-8',
          status: 'failed',
          error: 'Repository not found',
        });
        yield* h.sessions.stopAll;
        expect(finalsOf(h.sent, 'session-acme-8')).toHaveLength(1);
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expectNoSecret(h);
      }),
    ));

  it('is failed with the last line on stderr when the start command exits before ready', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': (child) => {
                child.stderr('consola-host: warning: turns in /workspace/repo load…\n');
                child.stderr(
                  `consola-host: Cannot listen on 0.0.0.0:7420: EADDRINUSE (${GIT_TOKEN}).\n`,
                );
                return 1;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-9'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-9',
          status: 'failed',
          error: 'consola-host: Cannot listen on 0.0.0.0:7420: EADDRINUSE ([redacted]).',
        });
        yield* h.sessions.stopAll;
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
      }),
    ));

  it('is failed, and stops the sandbox, when the port ready names cannot be exposed', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          provider: (fake) => ({
            create: async (options) => {
              const sandbox = await fake.create(options);
              return {
                ...sandbox,
                exposePort: async () => {
                  throw new SandboxError('provider', `no route to port (token ${GIT_TOKEN})`);
                },
              };
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-10'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-10',
          status: 'failed',
          error: 'no route to port (token [redacted])',
        });
        yield* h.sessions.stopAll;
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expect(finalsOf(h.sent, 'session-acme-10')).toHaveLength(1);
      }),
    ));

  it("stops the sandbox on the cell's stop and says stopped once", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-11'));
        yield* h.next;
        yield* h.sessions.stop('session-acme-11');
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expect(finalsOf(h.sent, 'session-acme-11')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-11', status: 'stopped' },
        ]);
        yield* h.sessions.stop('session-acme-11');
        expect(finalsOf(h.sent, 'session-acme-11')).toHaveLength(1);
      }),
    ));

  it("stops a sandbox on the cell's stop before its host is ready, and says stopped", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-12'));
        yield* h.sessions.stop('session-acme-12');
        expect(h.fake.sandboxes.every((sandbox) => sandbox.state === 'stopped')).toBe(true);
        expect(h.sent).toEqual([
          { type: 'session.update', sessionId: 'session-acme-12', status: 'stopped' },
        ]);
      }),
    ));

  it.each([
    ['a repository', { repository: 'sprocket/other' }, /sprocket\/other/],
    ['a harness', { harness: 'codex' as Harness }, /codex/],
  ])('is failed, with no sandbox, for %s the runner does not offer', (_case, asked, message) =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          offer: { repositories: [REPOSITORY], harnesses: ['claude'] },
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-13', asked));
        const failed = yield* h.next;
        expect(failed).toMatchObject({ sessionId: 'session-acme-13', status: 'failed' });
        expect(failed.error).toMatch(message);
        expect(h.fake.sandboxes).toHaveLength(0);
        expect((yield* h.sessions.live).sessionIds).toEqual([]);
      }),
    ),
  );

  it('stops the sandbox at the lifetime cap, and says stopped', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          maxLifetime: Duration.millis(300),
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-14'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-14',
          status: 'stopped',
        });
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
      }),
    ));

  it('stops every sandbox when the runner stops, saying stopped for each', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-15'));
        yield* h.sessions.start(startOf('session-acme-16'));
        yield* h.next;
        yield* h.next;
        expect([...(yield* h.sessions.live).sessionIds].sort()).toEqual([
          'session-acme-15',
          'session-acme-16',
        ]);
        yield* h.sessions.stopAll;
        expect(h.fake.sandboxes.map((sandbox) => sandbox.state)).toEqual(['stopped', 'stopped']);
        expect(finalsOf(h.sent, 'session-acme-15')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-15', status: 'stopped' },
        ]);
        expect(finalsOf(h.sent, 'session-acme-16')).toHaveLength(1);
        expect((yield* h.sessions.live).sessionIds).toEqual([]);
      }),
    ));

  it('takes a second start for a session it holds as the same session', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-17'));
        yield* h.next;
        yield* h.sessions.start(startOf('session-acme-17'));
        yield* h.sessions.stopAll;
        expect(h.fake.sandboxes).toHaveLength(1);
      }),
    ));
});
