import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../../shared/conversation';
import type { Harness } from '../../shared/harness';
import type { HarnessModel } from '../../shared/types';
import type { Session, SessionUpdates, Workspace } from '../../shared/workspace';
import type {
  CliNameRead,
  HarnessConfig,
  HarnessDriver,
  TextGenerationRequest,
} from '../drivers/HarnessDriver';
import { FIRST_PROMPT_RETRY_MS, SessionNamer, TITLE_RETRY_MS } from './SessionNamer';
import { TITLE_SCHEMA } from './titlePrompts';

type NameUpdates = Pick<SessionUpdates, 'name' | 'nameIsUserSet'>;

/** A driver that answers from its fields and records every call. */
interface FakeDriver extends HarnessDriver {
  firstPrompt: string | null;
  /** Answers used first, one per read, before falling back to `firstPrompt`. */
  firstPromptQueue: (string | null)[];
  /** Holds every first-prompt read until it resolves. */
  firstPromptGate?: Promise<void>;
  firstPromptCalls: number;
  firstPromptConfigs: HarnessConfig[];
  cliNames: (CliNameRead | null)[];
  cliConfigs: HarnessConfig[];
  cliFrom: number[];
  cliConversations: string[];
  answer: unknown;
  generateError?: Error;
  /** Runs inside the title call, before it answers. */
  onGenerate?: () => void | Promise<void>;
  generated: TextGenerationRequest[];
  generatedConfigs: HarnessConfig[];
  conversation: ConversationRecord | null;
  conversationReads: { config: HarnessConfig; conversationId: string }[];
}

function makeDriver(): FakeDriver {
  const driver: FakeDriver = {
    id: 'claude',
    configDirEnvVar: 'CLAUDE_CONFIG_DIR',
    resolveBinary: () => 'claude',
    profileDir: () => '/home/alice/.claude',
    buildSessionArgs: () => [],
    toolPolicyProblem: () => null,
    composeEnv: (_config, env) => env,
    probeHealth: () => Promise.reject(new Error('not used')),
    firstPrompt: null,
    firstPromptQueue: [],
    firstPromptCalls: 0,
    firstPromptConfigs: [],
    cliNames: [],
    cliConfigs: [],
    cliFrom: [],
    cliConversations: [],
    answer: { title: 'Generated Title' },
    generated: [],
    generatedConfigs: [],
    conversation: null,
    conversationReads: [],
    async readFirstPrompt(config) {
      driver.firstPromptCalls += 1;
      driver.firstPromptConfigs.push(config);
      await driver.firstPromptGate;
      if (driver.firstPromptQueue.length > 0) return driver.firstPromptQueue.shift() ?? null;
      return driver.firstPrompt;
    },
    async readCliNameSince(config, conversationId, from) {
      driver.cliConfigs.push(config);
      driver.cliFrom.push(from);
      driver.cliConversations.push(conversationId);
      return driver.cliNames.shift() ?? null;
    },
    async generateText(config, request) {
      driver.generated.push(request);
      driver.generatedConfigs.push(config);
      await driver.onGenerate?.();
      if (driver.generateError) throw driver.generateError;
      return driver.answer;
    },
    async readConversation(config, conversationId) {
      driver.conversationReads.push({ config, conversationId });
      return driver.conversation;
    },
  };
  return driver;
}

function makeHarness(id: string, name: string, overrides: Partial<Harness> = {}): Harness {
  return {
    id,
    driverId: 'claude',
    name,
    accentColor: '#4f5bd5',
    enabled: true,
    archived: false,
    isBuiltIn: false,
    configDir: `/config/${id}`,
    extraArgs: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'New Session',
    workspaceId: 'ws',
    instanceId: 'inst-1',
    claudeSessionId: 'conv-1',
    hasStarted: true,
    harnessId: 'claude-a',
    scopeId: 'scope-web',
    kind: 'interactive',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

function makeWorkspace(sessions: Session[]): Workspace {
  return {
    id: 'ws',
    name: 'Shop',
    defaultHarnessId: 'claude-a',
    scopes: [{ id: 'scope-web', name: 'web', path: '/repo/web', isGitRepo: true, createdAt: 0 }],
    groups: [],
    labels: [],
    actions: [],
    sectionDefaults: {},
    sessions,
    createdAt: 0,
    updatedAt: 0,
  };
}

const HAIKU: HarnessModel = {
  value: 'haiku',
  resolvedModel: 'claude-haiku-4-5',
  displayName: 'Haiku',
  description: 'Fastest',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high'],
  supportsFastMode: false,
};

const LONG_MESSAGE = 'Fix the login redirect loop when the SSO cookie expires and users bounce';
const LONG_STAND_IN = 'Fix the login redirect loop when the SSO cookie ex…';

/** Lets every pending promise chain run to completion. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SessionNamer', () => {
  let workspaces: Workspace[];
  let harnesses: Harness[];
  let updates: NameUpdates[];
  let delays: number[];
  let modelInfo: HarnessModel | undefined;
  let modelInfoCalls: [string, string][];
  let failWrites: boolean;
  let driverIds: (string | undefined)[];
  let driver: FakeDriver;
  let namer: SessionNamer;

  function session(id = 's1'): Session {
    const found = workspaces.flatMap((w) => w.sessions).find((s) => s.id === id);
    if (!found) throw new Error(`No session ${id} in the fake store`);
    return found;
  }

  /** Replaces a record the way WorkspaceService does: a new object, never an edit in place. */
  function edit(id: string, patch: Partial<Session>): void {
    workspaces = workspaces.map((w) => ({
      ...w,
      sessions: w.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  function editWorkspace(patch: Partial<Workspace>): void {
    workspaces = workspaces.map((w) => ({ ...w, ...patch }));
  }

  function editHarness(id: string, patch: Partial<Harness>): void {
    harnesses = harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h));
  }

  /** A rename made in Consola, which never goes through the namer. */
  const rename = (name: string) => edit('s1', { name, nameIsUserSet: true });

  const removeSession = () => {
    workspaces = workspaces.map((w) => ({
      ...w,
      sessions: w.sessions.filter((s) => s.id !== 's1'),
    }));
  };

  beforeEach(() => {
    workspaces = [makeWorkspace([makeSession()])];
    harnesses = [makeHarness('claude-a', 'Claude A'), makeHarness('claude-b', 'Claude B')];
    updates = [];
    delays = [];
    modelInfo = HAIKU;
    modelInfoCalls = [];
    failWrites = false;
    driverIds = [];
    driver = makeDriver();
    namer = new SessionNamer({
      getWorkspaces: () => workspaces,
      getHarnesses: () => harnesses,
      updateSession: (workspaceId, sessionId, applied) => {
        const target = workspaces
          .find((w) => w.id === workspaceId)
          ?.sessions.find((s) => s.id === sessionId);
        if (!target) throw new Error(`No session ${sessionId}`);
        if (failWrites) throw new Error('The disk is full.');
        updates.push(applied);
        edit(sessionId, applied);
      },
      getDriver: (id) => {
        driverIds.push(id);
        return driver;
      },
      modelInfo: async (harness, model) => {
        modelInfoCalls.push([harness.id, model]);
        return modelInfo;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names a blank session from its first message, then writes the generated title', async () => {
    driver.firstPrompt = LONG_MESSAGE;
    driver.answer = { title: 'SSO Login Redirect Loop' };

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([{ name: LONG_STAND_IN }, { name: 'SSO Login Redirect Loop' }]);
    expect(session()).toMatchObject({ name: 'SSO Login Redirect Loop' });
    expect(session().nameIsUserSet).toBeUndefined();
    expect(driver.generated).toHaveLength(1);
    expect(driver.generated[0]).toMatchObject({
      model: 'haiku',
      effort: 'low',
      schema: TITLE_SCHEMA,
    });
    expect(driver.generated[0].prompt).toContain('Never include the scope name ("web")');
    expect(driver.generated[0].prompt).toContain(LONG_MESSAGE);
    expect(driver.generatedConfigs[0].configDir).toBe('/config/claude-a');
    expect(modelInfoCalls).toEqual([['claude-a', 'haiku']]);
  });

  it('never reads a first prompt for a named or user-named session', async () => {
    workspaces = [
      makeWorkspace([
        makeSession({ id: 's2', instanceId: 'inst-2', claudeSessionId: 'conv-2', name: 'Named' }),
        makeSession({
          id: 's3',
          instanceId: 'inst-3',
          claudeSessionId: 'conv-3',
          nameIsUserSet: true,
        }),
      ]),
    ];
    driver.firstPrompt = 'Hello there';

    for (const instanceId of ['inst-2', 'inst-3']) {
      namer.statusChanged(instanceId, 'working');
    }
    await namer.idle();

    expect(driver.firstPromptCalls).toBe(0);
    expect(updates).toEqual([]);
    // CLI renames are still read for every live session.
    expect(driver.cliConversations).toEqual(['conv-2', 'conv-3']);
  });

  it('ignores an edge from a terminal it has no session for', async () => {
    namer.statusChanged('inst-unknown', 'working');
    await namer.idle();

    expect(driver.firstPromptCalls).toBe(0);
    expect(driver.cliFrom).toEqual([]);
  });

  it('retries a missing first prompt after a working edge, about a second in', async () => {
    driver.firstPromptQueue = [null, null, 'Hello there'];

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(FIRST_PROMPT_RETRY_MS).toEqual([400, 1200]);
    expect(delays).toEqual(expect.arrayContaining([400, 1200]));
    expect(driver.firstPromptCalls).toBe(3);
    expect(session().name).toBe('Generated Title');
    expect(updates[0]).toEqual({ name: 'Hello there' });
  });

  it('does not retry a missing first prompt after an edge that is not working', async () => {
    namer.statusChanged('inst-1', 'ready');
    await namer.idle();

    expect(delays).toEqual([]);
    expect(driver.firstPromptCalls).toBe(1);
    expect(session().name).toBe('New Session');
  });

  it('keeps one set of first-prompt retries per session', async () => {
    const gate = deferred();
    driver.firstPromptGate = gate.promise;

    namer.statusChanged('inst-1', 'working');
    await flush();
    namer.statusChanged('inst-1', 'working');
    gate.resolve();
    await namer.idle();

    // The coalesced working edge found no message either, and retries were already scheduled.
    expect(delays).toEqual([400, 1200]);
  });

  it('coalesces edges that arrive during a read into one more read', async () => {
    const gate = deferred();
    driver.firstPromptGate = gate.promise;
    driver.firstPromptQueue = [null, 'Hello there'];

    namer.statusChanged('inst-1', 'ready');
    await flush();
    expect(driver.firstPromptCalls).toBe(1);

    namer.statusChanged('inst-1', 'ready');
    namer.statusChanged('inst-1', 'ready');
    namer.statusChanged('inst-1', 'ready');
    await flush();
    expect(driver.firstPromptCalls).toBe(1);

    gate.resolve();
    await namer.idle();

    expect(driver.firstPromptCalls).toBe(2);
    expect(updates[0]).toEqual({ name: 'Hello there' });
  });

  it('does not write a stand-in when the session is renamed during the read', async () => {
    const gate = deferred();
    driver.firstPromptGate = gate.promise;
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await flush();
    rename('Mine');
    gate.resolve();
    await namer.idle();

    expect(updates).toEqual([]);
    expect(driver.generated).toEqual([]);
    expect(session()).toMatchObject({ name: 'Mine', nameIsUserSet: true });
  });

  it('makes no title call for a first message that reads as the placeholder', async () => {
    driver.firstPrompt = '  new   session ';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();
    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([]);
    expect(driver.generated).toEqual([]);
  });

  it('lets a rename made during the title call win', async () => {
    driver.firstPrompt = 'Hello there';
    driver.onGenerate = () => rename('Mine');

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([{ name: 'Hello there' }]);
    expect(session()).toMatchObject({ name: 'Mine', nameIsUserSet: true });
  });

  it('retries the first title twice, 2 s then 4 s, then keeps the stand-in quietly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    driver.firstPrompt = 'Hello there';
    driver.generateError = new Error('boom');

    expect(() => namer.statusChanged('inst-1', 'working')).not.toThrow();
    await namer.idle();

    expect(TITLE_RETRY_MS).toEqual([2000, 4000]);
    expect(driver.generated).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
    expect(session().name).toBe('Hello there');
    expect(updates).toEqual([{ name: 'Hello there' }]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0])).toContain('boom');
  });

  it('stops retrying the first title once a rename has won', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    driver.firstPrompt = 'Hello there';
    driver.generateError = new Error('boom');
    driver.onGenerate = () => rename('Mine');

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driver.generated).toHaveLength(1);
    expect(session()).toMatchObject({ name: 'Mine', nameIsUserSet: true });
  });

  it('writes the title from a retry that succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    driver.firstPrompt = 'Hello there';
    driver.generateError = new Error('boom');
    driver.onGenerate = () => {
      if (driver.generated.length === 2) driver.generateError = undefined;
    };

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driver.generated).toHaveLength(2);
    expect(delays).toEqual([2000]);
    expect(session().name).toBe('Generated Title');
  });

  it.each([
    ['the placeholder', { title: 'New Session' }],
    ['an empty title', { title: '   ' }],
    ['no title', {}],
    ['an array', [{ title: 'In an array' }]],
    ['a bare string', 'Bare'],
    ['null', null],
  ])('writes nothing for %s', async (_case, answer) => {
    driver.firstPrompt = 'Hello there';
    driver.answer = answer;

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([{ name: 'Hello there' }]);
    expect(driver.generated).toHaveLength(1);
  });

  it('cleans up the generated title before writing it', async () => {
    driver.firstPrompt = 'Hello there';
    driver.answer = { title: '"Greeting Exchange"\nsecond line' };

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(session().name).toBe('Greeting Exchange');
  });

  it.each([
    ['titles are off', () => editWorkspace({ sessionTitles: { source: 'off' } })],
    ['the harness is disabled', () => editHarness('claude-a', { enabled: false })],
    ['the harness is archived', () => editHarness('claude-a', { archived: true })],
    [
      'the title harness cannot generate',
      () => {
        delete driver.generateText;
      },
    ],
  ])('writes the stand-in but makes no call when %s', async (_case, arrange) => {
    arrange();
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([{ name: 'Hello there' }]);
    expect(driver.generated).toEqual([]);
  });

  it('titles with the pinned harness, its model and the workspace instructions', async () => {
    editWorkspace({
      sessionTitles: {
        source: 'pinned',
        harnessId: 'claude-b',
        model: 'sonnet',
        effort: 'default',
        instructions: 'Use title case.',
      },
    });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(modelInfoCalls).toEqual([['claude-b', 'sonnet']]);
    expect(driver.generatedConfigs[0].configDir).toBe('/config/claude-b');
    expect(driver.generated[0].model).toBe('sonnet');
    expect(driver.generated[0].effort).toBeUndefined();
    expect(driver.generated[0].prompt).toContain('Use title case.');
  });

  it('drops effort and Fast the model does not support', async () => {
    modelInfo = {
      ...HAIKU,
      supportsEffort: true,
      supportedEffortLevels: ['low'],
      supportsFastMode: false,
    };
    editWorkspace({ sessionTitles: { source: 'default-harness', fast: true } });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driver.generated[0]).toEqual(expect.objectContaining({ effort: 'low' }));
    expect(driver.generated[0].fast).toBeUndefined();
    expect('fast' in driver.generated[0]).toBe(false);
  });

  it('drops an effort level the model does not list, and sends Fast when it is supported', async () => {
    modelInfo = { ...HAIKU, supportedEffortLevels: ['low'], supportsFastMode: true };
    editWorkspace({ sessionTitles: { source: 'default-harness', effort: 'high', fast: true } });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect('effort' in driver.generated[0]).toBe(false);
    expect(driver.generated[0].fast).toBe(true);
  });

  it('sends neither effort nor Fast when the model is unknown', async () => {
    modelInfo = undefined;
    editWorkspace({ sessionTitles: { source: 'default-harness', fast: true } });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driver.generated[0]).toEqual({
      prompt: expect.any(String),
      schema: TITLE_SCHEMA,
      model: 'haiku',
    });
  });

  it.each([
    ['the session is deleted', () => removeSession()],
    [
      'its workspace is removed',
      () => {
        workspaces = [];
      },
    ],
  ])('does not write or throw when %s during the title call', async (_case, remove) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.firstPrompt = 'Hello there';
    driver.onGenerate = remove;

    expect(() => namer.statusChanged('inst-1', 'working')).not.toThrow();
    await namer.idle();

    expect(updates).toEqual([{ name: 'Hello there' }]);
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a write that throws, and lets nothing escape', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.firstPrompt = 'Hello there';
    failWrites = true;

    expect(() => namer.statusChanged('inst-1', 'working')).not.toThrow();
    await namer.idle();

    expect(updates).toEqual([]);
    expect(driver.generated).toEqual([]);
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0])).toContain('The disk is full.');
  });

  it('logs a failing transcript read, and still names the session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    driver.readCliNameSince = () => Promise.reject(new Error('EACCES'));
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(session().name).toBe('Generated Title');
    expect(String(error.mock.calls[0])).toContain('EACCES');
  });

  it('leaves a session awaiting a name when its driver cannot read a first prompt', async () => {
    delete driver.readFirstPrompt;

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(updates).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('reads with the session’s own harness and titles with the title harness', async () => {
    editWorkspace({ sessionTitles: { source: 'pinned', harnessId: 'claude-b' } });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driver.cliConfigs.map((c) => c.configDir)).toEqual(['/config/claude-a']);
    expect(driver.firstPromptConfigs.map((c) => c.configDir)).toEqual(['/config/claude-a']);
    expect(driver.generatedConfigs.map((c) => c.configDir)).toEqual(['/config/claude-b']);
    expect(driverIds).toContain('claude');
  });

  it('names a session whose harness has no record, as the built-in harness', async () => {
    edit('s1', { harnessId: 'default' });
    driver.firstPrompt = 'Hello there';

    namer.statusChanged('inst-1', 'working');
    await namer.idle();

    expect(driverIds[0]).toBeUndefined();
    expect(driver.firstPromptConfigs).toEqual([{ extraArgs: [] }]);
    expect(session().name).toBe('Generated Title');
  });

  describe('CLI renames', () => {
    it('adopts a /rename in a brand-new conversation as user-set', async () => {
      driver.cliNames = [null, { name: 'My name', next: 120 }]; // first sight: no transcript

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      namer.statusChanged('inst-1', 'working');
      await namer.idle();

      expect(session()).toMatchObject({ name: 'My name', nameIsUserSet: true });
      expect(updates).toEqual([{ name: 'My name', nameIsUserSet: true }]);
      // Read on the first edge only; no longer awaiting a name after.
      expect(driver.firstPromptCalls).toBe(1);
      expect(driver.cliFrom).toEqual([0, 0]);
    });

    it('takes a title already there at first read of an existing conversation as the baseline', async () => {
      edit('s1', { name: 'Named' });
      driver.cliNames = [
        { name: 'Given before', next: 100 },
        { name: 'Given now', next: 140 },
      ];

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      expect(updates).toEqual([]);

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      expect(updates).toEqual([{ name: 'Given now', nameIsUserSet: true }]);
    });

    it("takes a fork's copied title as the baseline, then adopts a later rename", async () => {
      edit('s1', { name: 'Review PR 12 (full tools)' });
      driver.cliNames = [
        null,
        { name: 'Source title', next: 900 },
        { name: 'Source title', next: 950 },
        { name: 'Fork rename', next: 990 },
      ];

      for (let edge = 0; edge < 4; edge += 1) {
        namer.statusChanged('inst-1', edge % 2 === 0 ? 'working' : 'ready');
        await namer.idle();
      }

      expect(updates).toEqual([{ name: 'Fork rename', nameIsUserSet: true }]);
      expect(driver.cliFrom).toEqual([0, 0, 900, 950]);
      expect(driver.firstPromptCalls).toBe(0);
    });

    it("never adopts a fork's inherited title, though its file is written only at the first message", async () => {
      edit('s1', { name: 'Review PR 12 (full tools)' });
      driver.cliNames = [null, { name: 'Source title (fork)', next: 900 }];

      namer.statusChanged('inst-1', 'working');
      await namer.idle();
      namer.statusChanged('inst-1', 'ready');
      await namer.idle();

      expect(updates).toEqual([]);
      expect(session().name).toBe('Review PR 12 (full tools)');
    });

    it('does not take back a name read with nothing new since', async () => {
      edit('s1', { name: 'Named' });
      driver.cliNames = [
        { name: 'Baseline', next: 100 },
        { name: null, next: 150 },
        { name: 'Baseline', next: 200 },
      ];

      for (let edge = 0; edge < 3; edge += 1) {
        namer.statusChanged('inst-1', 'ready');
        await namer.idle();
      }

      expect(updates).toEqual([]);
      expect(driver.cliFrom).toEqual([0, 100, 150]);
    });

    it('re-baselines when the session moves to another conversation', async () => {
      edit('s1', { name: 'Named' });
      driver.cliNames = [
        { name: 'Old', next: 500 },
        { name: null, next: 600 },
        { name: 'Copied over', next: 300 },
        { name: 'Renamed', next: 350 },
      ];

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      edit('s1', { claudeSessionId: 'conv-2' });
      namer.statusChanged('inst-1', 'ready');
      await namer.idle();

      expect(driver.cliFrom).toEqual([0, 500, 0]);
      expect(driver.cliConversations).toEqual(['conv-1', 'conv-1', 'conv-2']);
      expect(updates).toEqual([]);

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();

      expect(driver.cliFrom).toEqual([0, 500, 0, 300]);
      expect(updates).toEqual([{ name: 'Renamed', nameIsUserSet: true }]);
    });

    it('cleans up an adopted name, and adopts nothing that cleans up to the placeholder', async () => {
      driver.cliNames = [
        { name: 'New Session', next: 10 },
        { name: '  `Quoted name`  ', next: 20 },
      ];

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      expect(updates).toEqual([]);

      namer.statusChanged('inst-1', 'ready');
      await namer.idle();
      expect(updates).toEqual([{ name: 'Quoted name', nameIsUserSet: true }]);
    });

    it('makes an in-flight title lose to a CLI rename', async () => {
      driver.firstPrompt = 'Hello there';
      driver.cliNames = [null, { name: 'From the CLI', next: 80 }];
      driver.onGenerate = async () => {
        namer.statusChanged('inst-1', 'working');
        await flush();
      };

      namer.statusChanged('inst-1', 'working');
      await namer.idle();

      expect(driver.generated).toHaveLength(1);
      expect(updates).toEqual([
        { name: 'Hello there' },
        { name: 'From the CLI', nameIsUserSet: true },
      ]);
      expect(session()).toMatchObject({ name: 'From the CLI', nameIsUserSet: true });
    });
  });

  describe('regenerate', () => {
    const conversation: ConversationRecord = {
      entries: [
        { kind: 'prompt', text: 'Fix it' },
        { kind: 'step', tool: 'Bash' },
        { kind: 'text', text: 'Fixed the redirect.' },
      ],
      truncated: false,
    };

    beforeEach(() => {
      edit('s1', { name: 'Mine', nameIsUserSet: true });
      driver.conversation = conversation;
      driver.answer = { title: 'Login Redirect Fix' };
    });

    it('replaces a typed name and leaves nameIsUserSet alone', async () => {
      await namer.regenerate('ws', 's1');

      expect(updates).toEqual([{ name: 'Login Redirect Fix' }]);
      expect(session()).toMatchObject({ name: 'Login Redirect Fix', nameIsUserSet: true });
    });

    it('replaces a generated name without marking it user-set', async () => {
      edit('s1', { name: 'Old Title', nameIsUserSet: undefined });

      await namer.regenerate('ws', 's1');

      expect(updates).toEqual([{ name: 'Login Redirect Fix' }]);
      expect(session().nameIsUserSet).toBeUndefined();
    });

    it('sends the conversation and the previous title', async () => {
      await namer.regenerate('ws', 's1');

      expect(driver.generated).toHaveLength(1);
      expect(driver.generated[0].prompt).toContain('The previous title was "Mine".');
      expect(driver.generated[0].prompt).toContain('USER: Fix it');
      expect(driver.generated[0].prompt).toContain('ASSISTANT: Fixed the redirect.');
      expect(driver.generated[0].prompt).toContain('Never include the scope name ("web")');
      expect(driver.generated[0]).toMatchObject({
        model: 'haiku',
        effort: 'low',
        schema: TITLE_SCHEMA,
      });
    });

    it('reads with the session’s harness and titles with the title harness', async () => {
      editWorkspace({ sessionTitles: { source: 'pinned', harnessId: 'claude-b' } });

      await namer.regenerate('ws', 's1');

      expect(driver.conversationReads).toEqual([
        {
          config: expect.objectContaining({ configDir: '/config/claude-a' }),
          conversationId: 'conv-1',
        },
      ]);
      expect(driver.generatedConfigs[0].configDir).toBe('/config/claude-b');
    });

    it('lets a rename during the call win', async () => {
      driver.onGenerate = () => rename('Renamed meanwhile');

      await expect(namer.regenerate('ws', 's1')).resolves.toBeUndefined();

      expect(updates).toEqual([]);
      expect(session()).toMatchObject({ name: 'Renamed meanwhile', nameIsUserSet: true });
    });

    it('returns quietly when the session is deleted during the call', async () => {
      driver.onGenerate = () => removeSession();

      await expect(namer.regenerate('ws', 's1')).resolves.toBeUndefined();

      expect(updates).toEqual([]);
    });

    it('rejects with the error of a write that throws', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      failWrites = true;

      await expect(namer.regenerate('ws', 's1')).rejects.toThrow('The disk is full.');

      expect(updates).toEqual([]);
      expect(session()).toMatchObject({ name: 'Mine', nameIsUserSet: true });
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('logs a conversation read that throws, and rejects in words for the person', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      driver.readConversation = async () => {
        throw new Error('EACCES: permission denied, open /config/claude-a/projects/x/conv-1.jsonl');
      };

      await expect(namer.regenerate('ws', 's1')).rejects.toThrow(
        /^Could not read this session’s conversation\.$/,
      );

      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][1])).toContain('EACCES');
      expect(driver.generated).toEqual([]);
      expect(updates).toEqual([]);
    });

    it('never retries and never falls back to another harness', async () => {
      editWorkspace({ sessionTitles: { source: 'pinned', harnessId: 'claude-b' } });
      editHarness('claude-b', { archived: true });

      await expect(namer.regenerate('ws', 's1')).rejects.toThrow('Claude B is archived.');

      expect(driver.generated).toEqual([]);
      expect(delays).toEqual([]);
    });

    it.each<[string, string, number, () => void]>([
      [
        'off',
        'Titles are off for this workspace.',
        0,
        () => {
          editWorkspace({ sessionTitles: { source: 'off' } });
        },
      ],
      [
        'disabled harness',
        'Claude A is turned off.',
        0,
        () => {
          editHarness('claude-a', { enabled: false });
        },
      ],
      [
        'no conversation',
        'This session has no conversation to title yet.',
        0,
        () => {
          driver.conversation = null;
        },
      ],
      [
        'an empty conversation',
        'This session has no conversation to title yet.',
        0,
        () => {
          driver.conversation = { entries: [], truncated: false };
        },
      ],
      [
        'no conversation reader',
        'This session has no conversation to title yet.',
        0,
        () => {
          delete driver.readConversation;
        },
      ],
      [
        'CLI failure',
        'Not logged in',
        1,
        () => {
          driver.generateError = new Error('Not logged in');
        },
      ],
      [
        'no generateText',
        'Claude A can’t write titles.',
        0,
        () => {
          delete driver.generateText;
        },
      ],
      [
        'an empty title',
        'The title model returned no title.',
        1,
        () => {
          driver.answer = { title: '' };
        },
      ],
      ['a missing session', 'This session no longer exists.', 0, () => removeSession()],
    ])('fails with a message when %s', async (_case, message, calls, arrange) => {
      arrange();

      await expect(namer.regenerate('ws', 's1')).rejects.toThrow(message);

      expect(updates).toEqual([]);
      expect(driver.generated).toHaveLength(calls);
    });
  });
});
