import type { Harness, SessionStart, SessionUpdate } from '@consola/runner-protocol';
import { FakeProvider, SandboxError, sandboxesFrom } from '@consola/sandbox';
import type { FakeProcess, FakeProviderOptions, SandboxProvider } from '@consola/sandbox';
import type * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Queue from 'effect/Queue';
import { describe, expect, it } from 'vite-plus/test';
import { makeSandboxSessions } from './sandboxSessions.ts';
import type { SandboxSessions } from './sandboxSessions.ts';

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

/** Resolves after `duration`: a provider's call that takes its time. */
const delay = (duration: Duration.Input): Promise<void> =>
  Effect.runPromise(Effect.sleep(duration));

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
  readonly sent: readonly SessionUpdate[];
  /** Every line logged so far. */
  readonly logged: readonly string[];
  /**
   * Waits for the session's own path to finish (its "ended" log, which comes once its end is
   * said and its sandbox stopped); dies when it does not in time. Never `stopAll`, which would
   * stop the sandbox anyway.
   */
  readonly untilEnded: (sessionId: string) => Effect.Effect<void>;
};

const UPDATE_TIMEOUT = Duration.seconds(10);
/** Under the test's own 5 s, so a session that never ends fails with what it logged. */
const ENDED_TIMEOUT = Duration.seconds(4);

/**
 * The fake's own `attach` and `stop` by id, for a test's provider that changes only how a sandbox
 * is made: a provider answers both (`SandboxProvider`).
 */
const byId = (fake: FakeProvider): Pick<SandboxProvider, 'attach' | 'stop'> => ({
  attach: (sandboxId) => fake.attach(sandboxId),
  stop: (sandboxId) => fake.stop(sandboxId),
});

/**
 * The fake, but each sandbox ends in real time when its lifetime runs out, as E2B ends one: its
 * commands are killed (`wait` answers null) and it is gone. A renewal gives it a lifetime from
 * now. Its sandboxes renew (`keepAlive`), as E2B's do.
 */
const endingAtTheirLifetime = (fake: FakeProvider): SandboxProvider => {
  const ends = new Map<string, Fiber.Fiber<void>>();
  const endIn = (sandboxId: string, lifetimeSeconds: number | undefined) => {
    const before = ends.get(sandboxId);
    if (before !== undefined) Effect.runFork(Fiber.interrupt(before));
    if (lifetimeSeconds === undefined) return;
    const end = Effect.sleep(Duration.seconds(lifetimeSeconds)).pipe(
      Effect.andThen(Effect.promise(() => fake.stop(sandboxId))),
    );
    ends.set(sandboxId, Effect.runFork(end));
  };
  return {
    ...byId(fake),
    create: async (options) => {
      const sandbox = await fake.create(options);
      endIn(sandbox.id, options.lifetimeSeconds);
      return sandbox;
    },
    keepAlive: {
      renew: async (sandboxId, lifetimeSeconds) => {
        await fake.keepAlive?.renew(sandboxId, lifetimeSeconds);
        endIn(sandboxId, lifetimeSeconds);
      },
    },
  };
};

/** Sessions over a fake provider with `programs`, reporting into a queue a test reads. */
const harness = Effect.fn('harness')(function* (
  options: {
    readonly fake?: FakeProviderOptions;
    readonly provider?: (fake: FakeProvider) => SandboxProvider;
    readonly maxLifetime?: Duration.Input;
    readonly exitLineGrace?: Duration.Input;
    readonly stopTimeout?: Duration.Input;
    readonly shutdownStopTimeout?: Duration.Input;
    readonly callTimeout?: Duration.Input;
    readonly leaseRenewEvery?: Duration.Input;
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
    ...(options.stopTimeout === undefined ? {} : { stopTimeout: options.stopTimeout }),
    ...(options.shutdownStopTimeout === undefined
      ? {}
      : { shutdownStopTimeout: options.shutdownStopTimeout }),
    ...(options.callTimeout === undefined ? {} : { callTimeout: options.callTimeout }),
    ...(options.leaseRenewEvery === undefined ? {} : { leaseRenewEvery: options.leaseRenewEvery }),
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
    untilEnded: (sessionId) =>
      Effect.gen(function* () {
        while (!logged.includes(`session ${sessionId}: ended`)) {
          yield* Effect.sleep(Duration.millis(10));
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: ENDED_TIMEOUT,
          orElse: () =>
            Effect.die(new Error(`session ${sessionId} did not end; logged ${logged.join(' | ')}`)),
        }),
      ),
  };
  return harnessed;
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Nothing secret was sent to the cell or logged. */
const expectNoSecret = (h: Harnessed) => {
  const said = JSON.stringify({ sent: h.sent, logged: h.logged });
  for (const secret of SECRET_VALUES) expect(said).not.toContain(secret);
};

const finalsOf = (sent: readonly SessionUpdate[], sessionId: string) =>
  sent.filter(
    (update) =>
      update.sessionId === sessionId && (update.status === 'stopped' || update.status === 'failed'),
  );

describe('makeSandboxSessions', () => {
  it("creates the sandbox from the session template with the session's variables, its harness's key alone, and its ports public", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-1'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        const [sandbox] = h.fake.sandboxes;
        expect(sandbox?.template).toBe('consola-session');
        expect(sandbox?.publicPorts).toBe(true);
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
        yield* h.untilEnded('session-acme-4');
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
        yield* h.untilEnded('session-acme-8');
        expect(finalsOf(h.sent, 'session-acme-8')).toHaveLength(1);
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expectNoSecret(h);
      }),
    ));

  it('stops the sandbox of a session whose clone failed while its command runs on, and exposes no port for it', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                child.stdout(
                  line({ type: 'exit', reason: 'clone-failed', message: 'Repository not found' }),
                );
                child.stdout(line({ type: 'ready', port: 4100 }));
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-17'));
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-17',
          status: 'failed',
          error: 'Repository not found',
        });
        // The session's own path stops it: no stopAll, no lifetime cap (eight hours here).
        yield* h.untilEnded('session-acme-17');
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expect(h.fake.sandboxes[0]?.exposedPorts).toEqual([]);
        expect(h.sent).toHaveLength(1);
      }),
    ));

  it("reads the start script's clone-failed only before ready", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: {
            programs: {
              'consola-session-start': async (child) => {
                child.stdout(line({ type: 'ready', port: 4100 }));
                child.stdout(
                  line({ type: 'exit', reason: 'clone-failed', message: 'Repository not found' }),
                );
                child.stdout(line({ type: 'title', title: 'Sprocket catalog' }));
                await child.killed;
              },
            },
          },
        });
        yield* h.sessions.start(startOf('session-acme-18'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-18',
          title: 'Sprocket catalog',
        });
        expect((yield* h.sessions.live).sessionIds).toEqual(['session-acme-18']);
        expect(h.fake.sandboxes[0]?.state).toBe('running');
        yield* h.sessions.stop('session-acme-18');
        expect(finalsOf(h.sent, 'session-acme-18')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-18', status: 'stopped' },
        ]);
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
        yield* h.untilEnded('session-acme-9');
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
      }),
    ));

  it('is failed, and stops the sandbox, when the port ready names cannot be exposed', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          provider: (fake) => ({
            ...byId(fake),
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
        yield* h.untilEnded('session-acme-10');
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

  it.each([
    ["the cell's stop", (sessions: SandboxSessions) => sessions.stop('session-acme-19')],
    ['the runner stopping', (sessions: SandboxSessions) => sessions.stopAll],
  ])(
    "says the session's end on %s when its sandbox's stop never returns, once the stop times out",
    (_case, stopping) =>
      run(
        Effect.gen(function* () {
          const h = yield* harness({
            stopTimeout: Duration.millis(200),
            fake: { programs: { 'consola-session-start': readyUntilStopped() } },
            provider: (fake) => ({
              ...byId(fake),
              create: async (options) => {
                const sandbox = await fake.create(options);
                return { ...sandbox, stop: () => new Promise<void>(() => undefined) };
              },
            }),
          });
          yield* h.sessions.start(startOf('session-acme-19'));
          expect(yield* h.next).toMatchObject({ status: 'running' });
          yield* stopping(h.sessions).pipe(
            Effect.timeoutOrElse({
              duration: ENDED_TIMEOUT,
              orElse: () =>
                Effect.die(new Error(`the stop never returned; logged ${h.logged.join(' | ')}`)),
            }),
          );
          expect(finalsOf(h.sent, 'session-acme-19')).toEqual([
            { type: 'session.update', sessionId: 'session-acme-19', status: 'stopped' },
          ]);
          expect(h.logged).toContain(
            'session session-acme-19: its sandbox did not stop within 0.2 s; the runner goes on without it',
          );
          expect((yield* h.sessions.live).sessionIds).toEqual([]);
        }),
      ),
  );

  it("says each session's end when the runner stops before its sandbox's stop returns, and gives that stop less than the grace", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          shutdownStopTimeout: Duration.millis(300),
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          provider: (fake) => ({
            ...byId(fake),
            create: async (options) => {
              const sandbox = await fake.create(options);
              return { ...sandbox, stop: () => new Promise<void>(() => undefined) };
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-20'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        // The normal stop timeout is the default 30 s: only the shutdown's bound can end this.
        const stopping = yield* h.sessions.stopAll.pipe(Effect.forkChild);
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-20',
          status: 'stopped',
        });
        expect(h.logged).not.toContain('session session-acme-20: ended');
        yield* Fiber.join(stopping).pipe(
          Effect.timeoutOrElse({
            duration: ENDED_TIMEOUT,
            orElse: () =>
              Effect.die(new Error(`stopAll never returned; logged ${h.logged.join(' | ')}`)),
          }),
        );
        expect(h.logged).toContain(
          'session session-acme-20: its sandbox did not stop within 0.3 s of the runner stopping; the runner goes on without it',
        );
        expect(finalsOf(h.sent, 'session-acme-20')).toHaveLength(1);
      }),
    ));

  it.each<[string, (fake: FakeProvider) => SandboxProvider, RegExp]>([
    [
      'its sandbox is never made',
      (fake) => ({ ...byId(fake), create: () => new Promise(() => undefined) }),
      /^The sandbox was not made within 0\.3 s\.$/,
    ],
    [
      'its start command never starts',
      (fake) => ({
        ...byId(fake),
        create: async (options) => {
          const sandbox = await fake.create(options);
          return { ...sandbox, start: () => new Promise(() => undefined) };
        },
      }),
      /^The sandbox did not start the session within 0\.3 s\.$/,
    ],
    [
      'its port is never exposed',
      (fake) => ({
        ...byId(fake),
        create: async (options) => {
          const sandbox = await fake.create(options);
          return { ...sandbox, exposePort: () => new Promise(() => undefined) };
        },
      }),
      /^The sandbox did not expose the session's port within 0\.3 s\.$/,
    ],
  ])('is failed, its sandbox stopped, when %s in time', (_name, provider, error) =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          callTimeout: Duration.millis(300),
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          provider,
        });
        yield* h.sessions.start(startOf('session-acme-30'));
        const failed = yield* h.next;
        expect(failed).toMatchObject({ sessionId: 'session-acme-30', status: 'failed' });
        expect(failed.error).toMatch(error);
        yield* h.untilEnded('session-acme-30');
        expect(finalsOf(h.sent, 'session-acme-30')).toHaveLength(1);
        for (const record of h.fake.sandboxes) expect(record.state).toBe('stopped');
      }),
    ),
  );

  it('stops a sandbox that is made after its create timed out', () =>
    run(
      Effect.gen(function* () {
        let resolveCreate: (() => void) | undefined;
        const h = yield* harness({
          callTimeout: Duration.millis(200),
          provider: (fake) => ({
            ...byId(fake),
            create: (options) =>
              new Promise((resolve) => {
                resolveCreate = () => resolve(fake.create(options));
              }),
          }),
        });
        yield* h.sessions.start(startOf('session-acme-31'));
        expect(yield* h.next).toMatchObject({ status: 'failed' });
        resolveCreate?.();
        yield* Effect.gen(function* () {
          while (h.fake.sandboxes[0]?.state !== 'stopped') yield* Effect.sleep(Duration.millis(10));
        }).pipe(Effect.timeout(Duration.seconds(4)), Effect.orDie);
        expect(h.logged).toContain(
          'session session-acme-31: its sandbox was made after its create timed out; it is stopped',
        );
      }),
    ));

  it('bounds a stop that begins after the runner began stopping by what is left of the shutdown', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          shutdownStopTimeout: Duration.millis(1200),
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          // Made a second after it was asked for, a sandbox whose stop never returns.
          provider: (fake) => ({
            ...byId(fake),
            create: async (options) => {
              await delay(Duration.seconds(1));
              const sandbox = await fake.create(options);
              return { ...sandbox, stop: () => new Promise<void>(() => undefined) };
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-32'));
        const startedAt = yield* Clock.currentTimeMillis;
        yield* h.sessions.stopAll.pipe(
          Effect.timeoutOrElse({
            duration: ENDED_TIMEOUT,
            orElse: () =>
              Effect.die(new Error(`stopAll never returned; logged ${h.logged.join(' | ')}`)),
          }),
        );
        // Its stop began a second in, and got the 0.2 s the shutdown had left, not 1.2 s more.
        const tookMs = (yield* Clock.currentTimeMillis) - startedAt;
        expect(tookMs).toBeGreaterThanOrEqual(1100);
        expect(tookMs).toBeLessThan(1900);
        expect(h.logged).toContain(
          'session session-acme-32: its sandbox did not stop within 1.2 s of the runner stopping; the runner goes on without it',
        );
        expect(finalsOf(h.sent, 'session-acme-32')).toHaveLength(1);
      }),
    ));

  it("waits for a stopped sandbox's command no later than the shutdown's bound", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          shutdownStopTimeout: Duration.millis(300),
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          // The sandbox stops, but its command never says it ended.
          provider: (fake) => ({
            ...byId(fake),
            create: async (options) => {
              const sandbox = await fake.create(options);
              return {
                ...sandbox,
                start: async (command) => {
                  const running = await sandbox.start(command);
                  return { ...running, wait: () => new Promise(() => undefined) };
                },
              };
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-33'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        // The cell's stop: the sandbox stops, then its command is waited for, up to 10 s.
        const stopping = yield* h.sessions.stop('session-acme-33').pipe(Effect.forkChild);
        yield* Effect.gen(function* () {
          while (h.fake.sandboxes[0]?.state !== 'stopped') yield* Effect.sleep(Duration.millis(10));
        }).pipe(Effect.timeout(Duration.seconds(4)), Effect.orDie);
        // The runner stops meanwhile: that wait ends with the shutdown's 0.3 s.
        yield* h.sessions.stopAll.pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(3),
            orElse: () =>
              Effect.die(new Error(`stopAll waited on; logged ${h.logged.join(' | ')}`)),
          }),
        );
        yield* Fiber.join(stopping);
        expect(finalsOf(h.sent, 'session-acme-33')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-33', status: 'stopped' },
        ]);
      }),
    ));

  it('asks again a sandbox whose stop fails, and stops it', () =>
    run(
      Effect.gen(function* () {
        let stops = 0;
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
          provider: (fake) => ({
            ...byId(fake),
            create: async (options) => {
              const sandbox = await fake.create(options);
              return {
                ...sandbox,
                stop: async () => {
                  stops += 1;
                  if (stops <= 2) {
                    throw new SandboxError('provider', `E2B: kill failed (token ${GIT_TOKEN})`);
                  }
                  await sandbox.stop();
                },
              };
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-21'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        yield* h.sessions.stop('session-acme-21');
        expect(stops).toBe(3);
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
        expect(h.logged.filter((each) => each.includes('did not stop'))).toEqual([
          'session session-acme-21: its sandbox did not stop (attempt 1 of 3): E2B: kill failed (token [redacted])',
          'session session-acme-21: its sandbox did not stop (attempt 2 of 3): E2B: kill failed (token [redacted])',
        ]);
        expect(finalsOf(h.sent, 'session-acme-21')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-21', status: 'stopped' },
        ]);
        expectNoSecret(h);
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

  it('gives a sandbox the whole lifetime cap where its provider cannot renew one', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.start(startOf('session-acme-cap'));
        yield* h.next;
        // Eight hours, less the moment it took to make: the provider stops it by the cap.
        const lifetime = h.fake.sandboxes[0]?.lifetimeSeconds ?? 0;
        expect(lifetime).toBeLessThanOrEqual(8 * 3600);
        expect(lifetime).toBeGreaterThan(8 * 3600 - 60);
        yield* h.sessions.stopAll;
      }),
    ));

  it('leases a sandbox for ten minutes and renews the lease while it holds the session, then no more', () =>
    run(
      Effect.gen(function* () {
        const renewals: number[] = [];
        const h = yield* harness({
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          leaseRenewEvery: Duration.millis(50),
          provider: (fake) => ({
            ...byId(fake),
            create: (options) => fake.create(options),
            keepAlive: {
              renew: (sandboxId, lifetimeSeconds) => {
                renewals.push(lifetimeSeconds);
                return fake.keepAlive?.renew(sandboxId, lifetimeSeconds) ?? Promise.resolve();
              },
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-lease'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(h.fake.sandboxes[0]?.lifetimeSeconds).toBe(600);
        while (renewals.length < 3) yield* Effect.sleep(Duration.millis(10));
        expect(renewals.slice(0, 3)).toEqual([600, 600, 600]);
        expect(h.fake.sandboxes[0]?.remainingSeconds).toBe(600);

        yield* h.sessions.stop('session-acme-lease');
        const renewed = renewals.length;
        yield* Effect.sleep(Duration.millis(200));
        expect(renewals).toHaveLength(renewed);
      }),
    ));

  it('never renews a lease past the lifetime cap', () =>
    run(
      Effect.gen(function* () {
        const renewals: number[] = [];
        const h = yield* harness({
          maxLifetime: Duration.millis(2500),
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          leaseRenewEvery: Duration.millis(400),
          provider: (fake) => ({
            ...byId(fake),
            create: (options) => fake.create(options),
            keepAlive: {
              renew: (sandboxId, lifetimeSeconds) => {
                renewals.push(lifetimeSeconds);
                return fake.keepAlive?.renew(sandboxId, lifetimeSeconds) ?? Promise.resolve();
              },
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-lease-cap'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        // Two whole seconds are left of the cap as it is made, under the ten-minute lease.
        expect(h.fake.sandboxes[0]?.lifetimeSeconds).toBe(2);
        expect(yield* h.next).toMatchObject({ status: 'stopped' });
        expect(renewals.length).toBeGreaterThan(0);
        for (const seconds of renewals) {
          expect(seconds).toBeGreaterThanOrEqual(1);
          expect(seconds).toBeLessThanOrEqual(2);
        }
      }),
    ));

  it('logs a lease that was not renewed, without a secret, and keeps renewing', () =>
    run(
      Effect.gen(function* () {
        let asked = 0;
        const h = yield* harness({
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          leaseRenewEvery: Duration.millis(50),
          provider: (fake) => ({
            ...byId(fake),
            create: (options) => fake.create(options),
            keepAlive: {
              renew: async () => {
                asked += 1;
                throw new SandboxError('provider', `E2B: rate limited (token ${GIT_TOKEN})`);
              },
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-lease-fails'));
        yield* h.next;
        while (asked < 2) yield* Effect.sleep(Duration.millis(10));
        expect(h.logged).toContain(
          "session session-acme-lease-fails: its sandbox's lease was not renewed: E2B: rate limited (token [redacted])",
        );
        yield* h.sessions.stopAll;
        expectNoSecret(h);
      }),
    ));

  it('ends a session at its lifetime cap as stopped, before its provider ends the sandbox there', () =>
    run(
      Effect.gen(function* () {
        // The cap is 2.5 s, the stop's own bound 1 s. The sandbox is made with the cap's two
        // whole seconds, and renewed at 1.2 s with its one: its provider ends it at about 2.2 s,
        // before the cap, as E2B's deadline lands up to a second before it. The runner's own
        // stop comes first (1.5 s), so the session is stopped, not failed as a sandbox that
        // ended by itself.
        const h = yield* harness({
          maxLifetime: Duration.millis(2500),
          stopTimeout: Duration.seconds(1),
          leaseRenewEvery: Duration.millis(1200),
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          provider: endingAtTheirLifetime,
        });
        yield* h.sessions.start(startOf('session-acme-cap-race'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        expect(h.fake.sandboxes[0]?.lifetimeSeconds).toBe(2);
        expect(yield* h.next).toEqual({
          type: 'session.update',
          sessionId: 'session-acme-cap-race',
          status: 'stopped',
        });
        expect(h.logged).toContain(
          'session session-acme-cap-race: stopping its sandbox (lifetime)',
        );
        expect(h.fake.sandboxes[0]?.state).toBe('stopped');
      }),
    ));

  it('asks each renewal on time, however long the one before it takes', () =>
    run(
      Effect.gen(function* () {
        let asked = 0;
        const h = yield* harness({
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          leaseRenewEvery: Duration.millis(100),
          // A renewal that never answers holds its call for the whole call timeout, 60 s.
          provider: (fake) => ({
            ...byId(fake),
            create: (options) => fake.create(options),
            keepAlive: {
              renew: () => {
                asked += 1;
                return new Promise<void>(() => undefined);
              },
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-lease-hangs'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        yield* Effect.gen(function* () {
          while (asked < 3) yield* Effect.sleep(Duration.millis(10));
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(3),
            orElse: () => Effect.die(new Error(`${asked} renewal(s) asked in 3 s, not 3`)),
          }),
        );
        yield* h.sessions.stopAll;
      }),
    ));

  it('leaves a sandbox whose stop failed to its lease, which ends it ten minutes after its last renewal', () =>
    run(
      Effect.gen(function* () {
        let renewals = 0;
        const h = yield* harness({
          fake: {
            capabilities: ['keepAlive'],
            programs: { 'consola-session-start': readyUntilStopped() },
          },
          leaseRenewEvery: Duration.millis(50),
          // The runner cannot stop it: as a runner that is gone, it renews it no more.
          provider: (fake) => ({
            ...byId(fake),
            create: async (options) => {
              const sandbox = await fake.create(options);
              return {
                ...sandbox,
                stop: async () => {
                  throw new SandboxError('provider', 'E2B: kill failed');
                },
              };
            },
            keepAlive: {
              renew: (sandboxId, lifetimeSeconds) => {
                renewals += 1;
                return fake.keepAlive?.renew(sandboxId, lifetimeSeconds) ?? Promise.resolve();
              },
            },
          }),
        });
        yield* h.sessions.start(startOf('session-acme-lease-ends'));
        expect(yield* h.next).toMatchObject({ status: 'running' });
        while (renewals < 1) yield* Effect.sleep(Duration.millis(10));
        yield* h.sessions.stop('session-acme-lease-ends');
        expect(finalsOf(h.sent, 'session-acme-lease-ends')).toEqual([
          { type: 'session.update', sessionId: 'session-acme-lease-ends', status: 'stopped' },
        ]);
        const renewed = renewals;
        yield* Effect.sleep(Duration.millis(200));
        expect(renewals).toBe(renewed);

        const sandbox = h.fake.sandboxes[0];
        expect(sandbox?.state).toBe('running');
        expect(sandbox?.remainingSeconds).toBe(600);
        h.fake.elapse(599);
        expect(sandbox?.state).toBe('running');
        h.fake.elapse(1);
        expect(sandbox?.state).toBe('stopped');
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

  it('starts no sandbox for a start that comes once the runner is stopping', () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          fake: { programs: { 'consola-session-start': readyUntilStopped() } },
        });
        yield* h.sessions.stopAll;
        yield* h.sessions.start(startOf('session-acme-late'));
        expect(yield* h.next).toMatchObject({ sessionId: 'session-acme-late', status: 'failed' });
        expect(h.fake.sandboxes).toHaveLength(0);
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
