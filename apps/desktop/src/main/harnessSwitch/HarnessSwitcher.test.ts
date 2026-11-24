import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import type { ConversationRecord } from '../../shared/conversation';
import type { Harness } from '../../shared/harness';
import type { HarnessDriverId } from '../../shared/types';
import { switchedSession } from '../../shared/workspace';
import type { HarnessSwitchChange, Session, Workspace } from '../../shared/workspace';
import type { HarnessDriver } from '../drivers';
import { HarnessSwitcher } from './HarnessSwitcher';
import type { HarnessSwitcherDeps } from './HarnessSwitcher';

vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: process.env.PATH }) }));

function harness(id: string, driverId: HarnessDriverId, fields: Partial<Harness> = {}): Harness {
  return {
    id,
    driverId,
    name: id,
    accentColor: '#000',
    enabled: true,
    archived: false,
    isBuiltIn: false,
    configDir: `/config/${id}`,
    extraArgs: [],
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  };
}

const HARNESSES = [
  // Disabled, as a renamed built-in often is: still the home of its sessions.
  harness('default', 'claude', {
    name: 'Personal (built-in)',
    isBuiltIn: true,
    enabled: false,
    configDir: '/config/builtin',
  }),
  harness('personal', 'claude', { name: 'Claude - Personal' }),
  harness('work', 'claude', { name: 'Claude - Work' }),
  harness('codex', 'codex', { name: 'Codex', configDir: undefined }),
  harness('old', 'claude', { archived: true }),
  harness('off', 'claude', { enabled: false }),
];

const CONVERSATION: ConversationRecord = {
  entries: [
    { kind: 'prompt', text: 'Fix the flaky test' },
    { kind: 'text', text: 'Found a race in the setup.' },
  ],
  truncated: false,
};

function session(fields: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    name: 'Fix the flaky test',
    workspaceId: 'w',
    instanceId: 'instance-1',
    claudeSessionId: 'old-id',
    hasStarted: true,
    harnessId: 'personal',
    model: 'opus',
    scopeId: 'scope-1',
    kind: 'interactive',
    createdAt: 0,
    lastActiveAt: 0,
    ...fields,
  };
}

/** Everything a switch touches, recorded in the order it happened. */
function setup(
  options: {
    session?: Partial<Session>;
    terminal?: { refusal: string | null } | null;
    runIsOpen?: (runId: string) => boolean;
  } = {},
) {
  const calls: string[] = [];
  const workspace: Workspace = {
    id: 'w',
    name: 'w',
    defaultHarnessId: 'personal',
    scopes: [{ id: 'scope-1', name: 'repo', path: os.tmpdir(), isGitRepo: true, createdAt: 0 }],
    groups: [],
    labels: [],
    actions: [],
    sectionDefaults: {},
    sessions: [session(options.session)],
    createdAt: 0,
    updatedAt: 0,
  };
  const terminal = options.terminal === undefined ? { refusal: null } : options.terminal;
  let liveTerminal = terminal ? { switchRefusal: () => terminal.refusal } : undefined;

  const claude = {
    id: 'claude',
    probeHealth: vi.fn(async () => ({ available: true, resolvedBinary: 'claude' })),
    transplantConversation: vi.fn(
      async (
        from: { configDir?: string },
        to: { configDir?: string },
        id: string,
      ): Promise<'carried' | 'missing'> => {
        calls.push(`transplant ${id} ${from.configDir} -> ${to.configDir}`);
        return 'carried';
      },
    ),
    readConversation: vi.fn(async (): Promise<ConversationRecord | null> => CONVERSATION),
  };
  const codex = {
    id: 'codex',
    probeHealth: vi.fn(async () => ({ available: true, resolvedBinary: 'codex' })),
    readConversation: vi.fn(async (): Promise<ConversationRecord | null> => CONVERSATION),
  };
  const switchRecord = vi.fn(
    (_workspaceId: string, sessionId: string, change: HarnessSwitchChange) => {
      calls.push(`record ${change.harnessId} ${change.claudeSessionId}`);
      const next = switchedSession(
        workspace.sessions.find((candidate) => candidate.id === sessionId)!,
        change,
      );
      workspace.sessions = [next];
      return next;
    },
  );
  const deps: HarnessSwitcherDeps = {
    workspaces: { getAll: () => [workspace], switchHarness: switchRecord },
    harnesses: { getAll: () => HARNESSES },
    terminals: {
      get: () => liveTerminal,
      switchHarness: vi.fn((instanceId, change) => {
        calls.push(`terminal ${instanceId} ${change.claudeSessionId}`);
      }),
      destroy: vi.fn((instanceId) => {
        calls.push(`destroy ${instanceId}`);
      }),
    },
    launcher: {
      startRecorded: vi.fn(
        async (_workspaceId, recorded: Session, _launch, beforeStart?: () => void) => {
          beforeStart?.();
          calls.push(`start ${recorded.harnessId} ${recorded.claudeSessionId}`);
          liveTerminal = { switchRefusal: () => null };
        },
      ),
    },
    handoffs: {
      write: vi.fn(async (sessionId: string, fromHarnessId: string) => {
        calls.push(`handoff ${sessionId} ${fromHarnessId}`);
        return `/data/handoffs/${sessionId}/1-${fromHarnessId}.md`;
      }),
    },
    forgetAttention: vi.fn((instanceId) => {
      calls.push(`forget ${instanceId}`);
    }),
    driverFor: (id) => ((id ?? 'claude') === 'codex' ? codex : claude) as unknown as HarnessDriver,
    newConversationId: () => 'new-id',
    now: () => new Date('2026-11-17T21:00:00Z'),
    ...(options.runIsOpen ? { runIsOpen: options.runIsOpen } : {}),
  };
  return {
    switcher: new HarnessSwitcher(deps),
    deps,
    calls,
    claude,
    codex,
    switchRecord,
    workspace,
    openPane: () => {
      liveTerminal = { switchRefusal: () => null };
    },
  };
}

describe('HarnessSwitcher.preview', () => {
  it('lists the harnesses the person could pick, and what each would do', () => {
    const { switcher } = setup();
    expect(switcher.preview('w', 'session-1')).toEqual([
      {
        harnessId: 'work',
        ok: true,
        mode: 'native',
        summary: expect.stringMatching(/full history/),
      },
      {
        harnessId: 'codex',
        ok: true,
        mode: 'handoff',
        summary: expect.stringMatching(/transcript/),
      },
    ]);
  });

  it('refuses every harness while a turn is running', () => {
    const { switcher } = setup({ terminal: { refusal: 'In the middle of a turn.' } });
    expect(
      switcher
        .preview('w', 'session-1')
        .map((preview) => (preview.ok ? preview.mode : preview.reason)),
    ).toEqual(['In the middle of a turn.', 'In the middle of a turn.']);
  });

  it.each([['edit'], ['write']] as const)(
    'a %s session never switches harness (slice 3-B, Call 16)',
    async (policy) => {
      const { switcher } = setup({ session: { toolPolicy: policy } });
      for (const preview of switcher.preview('w', 'session-1'))
        expect(preview).toMatchObject({
          ok: false,
          reason:
            'A step that writes stays on its harness: its sandbox and environment were compiled for it.',
        });
      await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow(
        'A step that writes stays on its harness: its sandbox and environment were compiled for it.',
      );
    },
  );

  it('refuses a harness that cannot enforce the session’s tool policy', () => {
    const { switcher } = setup({ session: { toolPolicy: 'read-only' } });
    const [work, codex] = switcher.preview('w', 'session-1');
    expect(work).toMatchObject({ ok: true, mode: 'native' });
    expect(codex).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot be made read-only/),
    });
  });
});

describe('HarnessSwitcher.switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries a conversation natively: copied, then the record and the live terminal move together', async () => {
    const { switcher, calls, deps, switchRecord } = setup();
    const { session: switched, mode, summary } = await switcher.switch('w', 'session-1', 'work');
    expect(mode).toBe('native');
    expect(summary).toBe(
      'Switched from Claude - Personal to Claude - Work. The conversation continues with its full history.',
    );

    expect(calls).toEqual([
      'transplant old-id /config/personal -> /config/work',
      'record work new-id',
      'terminal instance-1 new-id',
      // What attention knew about the old process goes with it.
      'forget instance-1',
    ]);
    expect(switched).toMatchObject({ harnessId: 'work', claudeSessionId: 'new-id' });
    expect(switched).not.toHaveProperty('model');
    expect(switchRecord.mock.calls[0][2]).toEqual({
      harnessId: 'work',
      claudeSessionId: 'new-id',
      hasStarted: true,
      keepName: false,
      left: {
        harnessId: 'personal',
        claudeSessionId: 'old-id',
        continuedAs: 'new-id',
        endedAt: Date.parse('2026-11-17T21:00:00Z'),
        carried: 'native',
      },
    });
    expect(deps.terminals.switchHarness).toHaveBeenCalledWith('instance-1', {
      launch: {
        driverId: 'claude',
        binaryOverride: undefined,
        configDirOverride: '/config/work',
        extraArgs: [],
      },
      claudeSessionId: 'new-id',
      opening: { forkFrom: 'old-id' },
      notice:
        'Switched from Claude - Personal to Claude - Work. The conversation continues with its full history.',
    });
  });

  it('looks for the conversation where an edited built-in harness actually keeps it', async () => {
    // The built-in harness can be given a config folder of its own in
    // Settings; panes launch it there, so its conversations live there.
    const { switcher, calls } = setup({ session: { harnessId: 'default' } });
    await switcher.switch('w', 'session-1', 'work');
    expect(calls[0]).toBe('transplant old-id /config/builtin -> /config/work');
  });

  it('hands a conversation over between CLIs: a transcript written, then a fresh conversation told to read it', async () => {
    const { switcher, calls, deps, switchRecord, claude } = setup();
    await switcher.switch('w', 'session-1', 'codex');

    expect(claude.readConversation).toHaveBeenCalledWith(
      { binaryPath: undefined, configDir: '/config/personal', extraArgs: [] },
      'old-id',
    );
    expect(calls).toEqual([
      'handoff session-1 personal',
      'record codex new-id',
      'terminal instance-1 new-id',
      'forget instance-1',
    ]);
    const [, , markdown, at] = vi.mocked(deps.handoffs.write).mock.calls[0];
    expect(markdown).toContain('Found a race in the setup.');
    expect(markdown).toContain('to: "Codex"');
    // The file is named for the same moment the document says it was written.
    expect(at).toEqual(new Date('2026-11-17T21:00:00Z'));
    expect(markdown).toContain('switched: 2026-11-17T21:00:00.000Z');
    expect(switchRecord.mock.calls[0][2]).toMatchObject({
      keepName: true,
      left: {
        carried: 'handoff',
        handoffPath: '/data/handoffs/session-1/1-personal.md',
        continuedAs: 'new-id',
      },
    });
    const change = vi.mocked(deps.terminals.switchHarness).mock.calls[0][1];
    expect(change).toMatchObject({ launch: { driverId: 'codex' }, claudeSessionId: 'new-id' });
    expect(change.opening?.forkFrom).toBeUndefined();
    expect(change.opening?.prompt).toContain('/data/handoffs/session-1/1-personal.md');
  });

  it('points a second handoff back at the first', async () => {
    const { switcher, deps } = setup({
      session: {
        harnessId: 'codex',
        priorConversations: [
          {
            harnessId: 'personal',
            claudeSessionId: 'a',
            continuedAs: 'old-id',
            endedAt: 1,
            carried: 'handoff',
            handoffPath: '/h/first.md',
          },
        ],
      },
    });
    await switcher.switch('w', 'session-1', 'personal');
    expect(vi.mocked(deps.handoffs.write).mock.calls[0][2]).toContain('previous: "/h/first.md"');
  });

  it('starts a session with no terminal on the target first, then writes the record', async () => {
    const { switcher, calls, deps } = setup({ terminal: null });
    await switcher.switch('w', 'session-1', 'work');

    expect(calls).toEqual([
      'transplant old-id /config/personal -> /config/work',
      'start work new-id',
      'record work new-id',
      'forget instance-1',
    ]);
    const [, recorded, launch] = vi.mocked(deps.launcher.startRecorded).mock.calls[0];
    // Started from the very record that is then written, link and all, so a
    // relaunch that finds the fork missing knows to fork again.
    expect(recorded).toMatchObject({
      harnessId: 'work',
      claudeSessionId: 'new-id',
      hasStarted: true,
      priorConversations: [
        expect.objectContaining({ claudeSessionId: 'old-id', continuedAs: 'new-id' }),
      ],
    });
    expect(recorded).not.toHaveProperty('model');
    expect(launch).toEqual({ resume: false, forkFrom: 'old-id', initialPrompt: undefined });
  });

  it('stops the started terminal when the record cannot be written', async () => {
    const { switcher, calls, switchRecord } = setup({ terminal: null });
    switchRecord.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow('disk full');
    expect(calls.slice(-2)).toEqual(['destroy instance-1', 'forget instance-1']);
  });

  it('switches a pane that opened while the conversation was being copied, in place', async () => {
    const { switcher, calls, claude, openPane } = setup({ terminal: null });
    claude.transplantConversation.mockImplementationOnce(async () => {
      openPane();
      return 'carried';
    });
    await switcher.switch('w', 'session-1', 'work');
    expect(calls).toEqual([
      'record work new-id',
      'terminal instance-1 new-id',
      'forget instance-1',
    ]);
  });

  it('gives up when a pane opens the old conversation just before the target starts', async () => {
    const { switcher, calls, deps, openPane, switchRecord } = setup({ terminal: null });
    vi.mocked(deps.launcher.startRecorded).mockImplementationOnce(
      async (_w, _s, _l, beforeStart) => {
        openPane();
        beforeStart?.();
      },
    );
    await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow(
      /opened while it was being switched/,
    );
    expect(calls).toEqual(['transplant old-id /config/personal -> /config/work']);
    expect(switchRecord).not.toHaveBeenCalled();
  });

  it('only moves the record of a session that never started', async () => {
    const { switcher, calls, switchRecord } = setup({
      session: { hasStarted: false },
      terminal: null,
    });
    await switcher.switch('w', 'session-1', 'codex');
    expect(calls).toEqual(['record codex new-id']);
    expect(switchRecord.mock.calls[0][2]).toMatchObject({ hasStarted: false, left: undefined });
  });

  it('changes nothing when the target will not start', async () => {
    const { switcher, calls, claude } = setup();
    claude.probeHealth.mockResolvedValueOnce({
      available: false,
      resolvedBinary: 'claude',
      error: 'Not found',
    } as never);
    await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow(
      /Claude - Work cannot start: Not found/,
    );
    expect(calls).toEqual([]);
  });

  it('changes nothing when the conversation cannot be copied', async () => {
    const { switcher, calls, claude } = setup();
    claude.transplantConversation.mockRejectedValueOnce(new Error('disk full'));
    await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow('disk full');
    expect(calls).toEqual([]);
  });

  it('changes nothing, and says so, when it cannot find the conversation to carry', async () => {
    // Not finding a transcript is not knowing that nothing was said: the
    // conversation may live somewhere this harness does not point. A blank
    // start in its place would look like the history was lost.
    const native = setup();
    native.claude.transplantConversation.mockResolvedValueOnce('missing');
    await expect(native.switcher.switch('w', 'session-1', 'work')).rejects.toThrow(
      /could not find this conversation’s transcript under Claude - Personal\. Nothing was changed/,
    );
    expect(native.calls).toEqual([]);

    const handoff = setup({ terminal: null });
    handoff.claude.readConversation.mockResolvedValueOnce(null);
    await expect(handoff.switcher.switch('w', 'session-1', 'codex')).rejects.toThrow(
      /Nothing was changed/,
    );
    expect(handoff.calls).toEqual([]);
  });

  it('starts fresh on the target when the conversation is there but nothing has been said in it', async () => {
    const { switcher, deps, switchRecord, claude } = setup();
    claude.readConversation.mockResolvedValueOnce({ entries: [], truncated: false });
    // Less than the preview promised, and the result says so.
    expect(await switcher.switch('w', 'session-1', 'codex')).toMatchObject({
      mode: 'unstarted',
      summary: 'Switched from Claude - Personal to Codex.',
    });
    expect(deps.handoffs.write).not.toHaveBeenCalled();
    expect(switchRecord.mock.calls[0][2]).toMatchObject({
      harnessId: 'codex',
      keepName: false,
      left: undefined,
    });
    expect(vi.mocked(deps.terminals.switchHarness).mock.calls[0][1]).toEqual({
      launch: expect.objectContaining({ driverId: 'codex' }),
      claudeSessionId: 'new-id',
      notice: 'Switched from Claude - Personal to Codex.',
    });
  });

  it('refuses what the preview refuses, and harnesses it would not offer', async () => {
    await expect(
      setup({ terminal: { refusal: 'Busy.' } }).switcher.switch('w', 'session-1', 'work'),
    ).rejects.toThrow('Busy.');
    await expect(
      setup({ session: { toolPolicy: 'read-only' } }).switcher.switch('w', 'session-1', 'codex'),
    ).rejects.toThrow(/cannot be made read-only/);
    await expect(setup().switcher.switch('w', 'session-1', 'old')).rejects.toThrow(/not available/);
    await expect(setup().switcher.switch('w', 'session-1', 'off')).rejects.toThrow(/not available/);
    await expect(setup().switcher.switch('w', 'session-1', 'personal')).rejects.toThrow(
      /already runs on/,
    );
    await expect(setup().switcher.switch('w', 'nope', 'work')).rejects.toThrow(/no longer exists/);
  });

  it('refuses a turn that started while the switch was getting ready', async () => {
    const terminal = { refusal: null as string | null };
    const { switcher, calls, claude } = setup({ terminal });
    claude.transplantConversation.mockImplementationOnce(async () => {
      terminal.refusal = 'Busy now.';
      return 'carried';
    });
    await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow('Busy now.');
    expect(calls).toEqual([]);
  });

  it('takes one switch at a time per session', async () => {
    const { switcher, claude } = setup();
    let release!: () => void;
    claude.transplantConversation.mockImplementationOnce(
      () =>
        new Promise<'carried'>((resolve) => {
          release = () => resolve('carried');
        }),
    );
    const first = switcher.switch('w', 'session-1', 'work');
    await expect(switcher.switch('w', 'session-1', 'codex')).rejects.toThrow(/already switching/);
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await first;
  });
});

describe("HarnessSwitcher and a step's session", () => {
  beforeEach(() => vi.clearAllMocks());

  const GRANTS = {
    driverId: 'claude' as const,
    servers: [{ name: 'grafana' }],
    skills: [],
    allowedMcpServers: [{ serverName: 'consola' }, { serverName: 'grafana' }],
    strict: true,
    allowedTools: ['mcp__grafana__*'],
  };
  const STEP_SESSION: Partial<Session> = {
    toolPolicy: 'read-only',
    automation: { name: 'investigate-alerts', runId: 'r1', step: { id: 'look', attempt: 1 } },
    grants: GRANTS,
  };
  const OPEN =
    "This step's session stays on its agent's harness while its run is open. Switch it once the run has ended.";

  it('refuses while its run is open, and writes nothing', async () => {
    for (const fields of [STEP_SESSION, { ...STEP_SESSION, grants: undefined }]) {
      const { switcher, deps, switchRecord, calls } = setup({
        session: fields,
        runIsOpen: (id) => id === 'r1',
      });
      expect(
        switcher.preview('w', 'session-1').map((preview) => (preview.ok ? 'ok' : preview.reason)),
      ).toEqual([OPEN, OPEN]);
      await expect(switcher.switch('w', 'session-1', 'work')).rejects.toThrow(OPEN);
      expect(switchRecord).not.toHaveBeenCalled();
      expect(deps.terminals.switchHarness).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it('once its run has ended, switches, drops the grants and says so', async () => {
    const { switcher, deps, workspace } = setup({ session: STEP_SESSION, runIsOpen: () => false });
    const { session: switched } = await switcher.switch('w', 'session-1', 'work');
    expect(switched).not.toHaveProperty('grants');
    expect(workspace.sessions[0]).not.toHaveProperty('grants');
    expect(workspace.sessions[0]).toMatchObject({ toolPolicy: 'read-only', harnessId: 'work' });
    const change = vi.mocked(deps.terminals.switchHarness).mock.calls[0][1];
    expect(
      change.notice.endsWith(
        " Its agent's servers and skills stayed with Claude - Personal: on Claude - Work it has neither.",
      ),
    ).toBe(true);
  });

  it('a switch of a session with no grants says nothing of them', async () => {
    const { switcher, deps } = setup({
      session: { ...STEP_SESSION, grants: undefined },
      runIsOpen: () => false,
    });
    await switcher.switch('w', 'session-1', 'work');
    const change = vi.mocked(deps.terminals.switchHarness).mock.calls[0][1];
    expect(change.notice).not.toContain('servers and skills');
  });

  it("a legacy run's session, a hand-made one, or no way to ask, switch as before", async () => {
    const legacy = setup({
      session: { toolPolicy: 'read-only', automation: { name: 'nightly', runId: 'r1' } },
      runIsOpen: () => true,
    });
    await expect(legacy.switcher.switch('w', 'session-1', 'work')).resolves.toMatchObject({
      mode: 'native',
    });
    const handMade = setup({ runIsOpen: () => true });
    await expect(handMade.switcher.switch('w', 'session-1', 'work')).resolves.toMatchObject({
      mode: 'native',
    });
    const unasked = setup({ session: STEP_SESSION });
    await expect(unasked.switcher.switch('w', 'session-1', 'work')).resolves.toMatchObject({
      mode: 'native',
    });
  });
});
