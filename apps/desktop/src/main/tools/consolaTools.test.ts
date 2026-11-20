import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import type { LaunchSessionFields } from '../SessionLauncher';
import type { AutomationCapabilities, AutomationView } from '@consola/automation-engine';
import type { SnoozeView } from '../../shared/attention';
import {
  consolaTools,
  type AutomationControl,
  type ConsolaToolDeps,
  type SnoozeControl,
} from './consolaTools';
import { agentContext, ToolRegistry, type ToolContext } from './Tool';

/** The session asking: an ordinary one, in a worktree, in a group, on a pinned harness and model. */
const caller = () =>
  makeSession({
    id: 'me',
    name: 'Code review cost sizing',
    instanceId: 'inst-me',
    claudeSessionId: '11111111-1111-4111-8111-111111111111',
    hasStarted: true,
    kind: 'interactive',
    harnessId: 'work',
    model: 'opus',
    scopeId: 'scope-1',
    cwd: '/repos/app/.worktrees/sizing',
    groupId: 'grp-1',
    workItem: { provider: 'github', repo: 'sprocket/catalog-portal', number: 7, type: 'pr' },
    workItemAction: 'Review',
  });

let workspaces: Workspace[];
let launchSession: Mock<(workspaceId: string, fields: LaunchSessionFields) => Promise<Session>>;
let registry: ToolRegistry;
let capabilities: Mock<AutomationControl['capabilities']>;
let saveEntry: Mock<AutomationControl['saveEntry']>;
let trigger: Mock<AutomationControl['trigger']>;
let list: Mock<AutomationControl['list']>;
let allow: Mock<(workspaceId: string, name: string, version: string) => Promise<void>>;
let snoozer: { snooze: Mock<SnoozeControl['snooze']>; wake: Mock<SnoozeControl['wake']> };
let snoozeViews: Map<string, SnoozeView>;

function as(sessionId: string): ToolContext {
  return agentContext(sessionId, workspaces);
}

function start(args: Record<string, unknown>, context: ToolContext = as('me')) {
  return registry.invoke('start_session', args, context);
}

beforeEach(() => {
  workspaces = [
    makeWorkspace({
      sessions: [
        caller(),
        makeSession({
          id: 'ro',
          instanceId: 'inst-ro',
          kind: 'interactive',
          toolPolicy: 'read-only',
          hasStarted: true,
        }),
      ],
    }),
  ];
  capabilities = vi.fn(() => ({ grammar: 'g' }) as unknown as AutomationCapabilities);
  saveEntry = vi.fn(async () => ({
    name: 'sweep',
    replaced: false,
    entry: '- name: sweep',
    line: 3,
  }));
  trigger = vi.fn(async () => null);
  list = vi.fn(() => []);
  allow = vi.fn(async () => {});
  launchSession = vi.fn(async (_workspaceId: string, fields: LaunchSessionFields) =>
    makeSession({
      ...fields,
      id: 'new-1',
      kind: 'interactive',
      hasStarted: true,
    } as Partial<Session>),
  );
  snoozer = {
    snooze: vi.fn((_workspaceId, sessionIds) => ({
      applied: sessionIds,
      refused: [],
      memento: {},
      until: 1,
    })),
    wake: vi.fn((_workspaceId, sessionIds) => ({ applied: sessionIds, refused: [], memento: {} })),
  };
  snoozeViews = new Map();
  const deps: ConsolaToolDeps = {
    cleanup: {
      previewStale: vi.fn(),
      cleanupStale: vi.fn(),
      previewDelete: vi.fn(),
      deleteSession: vi.fn(),
    },
    getWorkspaces: () => workspaces,
    status: () => 'ready',
    attention: () => 'ready',
    isManagedPath: () => false,
    // `allow` is the runner's, beside what the tools may call: a test that it is never reached.
    automations: () => ({ list, trigger, capabilities, saveEntry, allow }) as AutomationControl,
    workItemContext: vi.fn(),
    inbox: () => null,
    launchSession,
    snoozer: () => snoozer,
    snoozes: () => snoozeViews,
  };
  registry = new ToolRegistry();
  consolaTools(deps).forEach((tool) => registry.register(tool));
});

describe('start_session', () => {
  it('opens a session beside the caller: its workspace, harness, model, folder and group', async () => {
    const result = await start({
      name: 'Digital twin design',
      prompt: '/resume-handoff ./handoff.md',
    });

    expect(launchSession).toHaveBeenCalledTimes(1);
    const [workspaceId, fields] = launchSession.mock.calls[0];
    expect(workspaceId).toBe('ws-1');
    expect(fields).toMatchObject({
      workspaceId: 'ws-1',
      name: 'Digital twin design',
      harnessId: 'work',
      model: 'opus',
      scopeId: 'scope-1',
      cwd: '/repos/app/.worktrees/sizing',
      groupId: 'grp-1',
      kind: 'interactive',
      initialPrompt: '/resume-handoff ./handoff.md',
    });
    expect(fields.instanceId).toEqual(expect.any(String));
    expect(fields.instanceId).not.toBe('inst-me');
    expect(result.data).toMatchObject({
      sessionId: 'new-1',
      name: 'Digital twin design',
      forked: false,
    });
    expect(result.summary).toMatch(/Started "Digital twin design"/);
  });

  it('starts a new conversation unless asked to fork, and never carries over what the caller is about', async () => {
    await start({ name: 'Digital twin design', prompt: 'go' });
    const [, fields] = launchSession.mock.calls[0];
    expect(fields.forkFrom).toBeUndefined();
    // A spin-off is about something else; the caller's item, action and
    // provenance describe the caller.
    expect(fields).not.toHaveProperty('workItem');
    expect(fields).not.toHaveProperty('workItemAction');
    expect(fields).not.toHaveProperty('toolPolicy');
    expect(fields).not.toHaveProperty('automation');
  });

  it('pins the name it was given, so the CLI’s title for the conversation does not replace it', async () => {
    // A fork's transcript opens with the caller's first prompt, which is what
    // the sidebar would otherwise adopt: two tabs with one name.
    await start({ name: 'Digital twin design', prompt: 'go', fork: true });
    expect(launchSession.mock.calls[0][1]).toMatchObject({ nameIsUserSet: true });
  });

  it('forks the caller’s own conversation when asked', async () => {
    const result = await start({
      name: 'Digital twin design',
      prompt: 'Carry on only the twin thread.',
      fork: true,
    });

    const [, fields] = launchSession.mock.calls[0];
    expect(fields).toMatchObject({
      forkFrom: '11111111-1111-4111-8111-111111111111',
      // The transcript is found from the folder it was written in.
      scopeId: 'scope-1',
      cwd: '/repos/app/.worktrees/sizing',
      harnessId: 'work',
      initialPrompt: 'Carry on only the twin thread.',
    });
    expect(result.data).toMatchObject({ forked: true });
    expect(result.summary).toMatch(/copy of this conversation/);
  });

  it('refuses to fork into another folder', async () => {
    await expect(
      start({ name: 'x', prompt: 'go', fork: true, scope_path: '/repos/parent' }),
    ).rejects.toThrow(/fork runs in your own folder/);
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('runs at the root of another of the workspace’s folders when scope_path names one', async () => {
    await start({ name: 'x', prompt: 'go', scope_path: '/repos/parent/' });
    const [, fields] = launchSession.mock.calls[0];
    expect(fields.scopeId).toBe('scope-2');
    expect(fields).not.toHaveProperty('cwd');
  });

  it('refuses a scope_path that is not one of the workspace’s folders', async () => {
    await expect(start({ name: 'x', prompt: 'go', scope_path: '/elsewhere' })).rejects.toThrow(
      /not one of this workspace’s folders/,
    );
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('refuses a read-only session, even if its call reaches the registry', async () => {
    // The MCP server never offers it one (it is mutating); this is the
    // second lock, in case another path ever does.
    await expect(start({ name: 'x', prompt: 'go' }, as('ro'))).rejects.toThrow(/read-only/);
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('is for agents only: no automation can name it', async () => {
    expect(registry.get('start_session')).toMatchObject({ mutating: true, automatable: false });
    expect(registry.get('start_session')?.destructive).toBeFalsy();
    await expect(
      start(
        { name: 'x', prompt: 'go' },
        {
          caller: { kind: 'automation', automation: 'sweep' },
          scope: { workspaceIds: 'all', excludeSessionIds: [] },
        },
      ),
    ).rejects.toThrow(/Only a session’s agent/);
    expect(launchSession).not.toHaveBeenCalled();
  });

  it('needs a name and a prompt', async () => {
    await expect(start({ name: '', prompt: 'go' })).rejects.toThrow(/Invalid arguments/);
    await expect(start({ name: 'x' })).rejects.toThrow(/Invalid arguments/);
    expect(launchSession).not.toHaveBeenCalled();
  });
});

describe('automation_capabilities', () => {
  it('returns the runner’s description for the caller’s workspace', async () => {
    const result = await registry.invoke('automation_capabilities', {}, as('me'));
    expect(capabilities).toHaveBeenCalledWith('ws-1');
    expect(result.data).toEqual({ grammar: 'g' });
    expect(registry.get('automation_capabilities')).toMatchObject({
      mutating: false,
      automatable: false,
      fullToolsOnly: true,
    });
  });
});

describe('save_automation', () => {
  it('passes the caller as the author, and replace through', async () => {
    const result = await registry.invoke(
      'save_automation',
      { entry: '- name: sweep', replace: true },
      as('me'),
    );
    expect(saveEntry).toHaveBeenCalledWith('ws-1', '- name: sweep', {
      replace: true,
      by: { sessionId: 'me', sessionName: 'Code review cost sizing' },
    });
    expect(result.data).toMatchObject({ name: 'sweep', replaced: false });
    expect(registry.get('save_automation')).toMatchObject({
      mutating: true,
      automatable: false,
      fullToolsOnly: true,
    });
  });

  it('does not replace unless asked, and needs an entry', async () => {
    await registry.invoke('save_automation', { entry: '- name: sweep' }, as('me'));
    expect(saveEntry.mock.calls[0][2].replace).toBe(false);
    await expect(registry.invoke('save_automation', { entry: '' }, as('me'))).rejects.toThrow(
      /Invalid arguments/,
    );
  });
});

describe('save_automation and Allow', () => {
  it('says a poll waits for Allow', async () => {
    saveEntry.mockResolvedValueOnce({
      name: 'sweep',
      replaced: false,
      entry: '- name: sweep',
      needsAllow: true,
    });
    const result = await registry.invoke('save_automation', { entry: '- name: sweep' }, as('me'));
    expect(result.summary).toBe(
      'Added sweep in factory.yml. It does not check until the person allows it in Consola.',
    );
  });

  it('does not say it waits for Allow when the entry has a problem, and says the problem', async () => {
    list.mockReturnValueOnce([
      { name: 'sweep', problem: 'its check command is empty' } as AutomationView,
    ]);
    const result = await registry.invoke('save_automation', { entry: '- name: sweep' }, as('me'));
    expect(result.summary).not.toMatch(/allows it/);
    expect(result.summary).toContain('It will not run: its check command is empty.');
  });

  it('leaves the summary alone for an entry that is neither', async () => {
    const result = await registry.invoke('save_automation', { entry: '- name: sweep' }, as('me'));
    expect(result.summary).toBe('Added sweep in factory.yml.');
  });

  it('gives an agent no way to allow: no tool allows, and running a poll does not', async () => {
    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .filter((name) => /allow|accept|approve_check/i.test(name)),
    ).toEqual([]);
    await registry.invoke('run_automation', { name: 'watch', item_key: 'k1' }, as('me'));
    await registry.invoke('run_automation', { name: 'watch' }, as('me'));
    expect(allow).not.toHaveBeenCalled();
  });

  it('types the control agents receive without allow', () => {
    // Compiled, never run: the pin is the typecheck.
    const pin = (control: AutomationControl, deps: ConsolaToolDeps) => {
      // @ts-expect-error Allow is the person's only: adding it to AutomationControl breaks the typecheck here.
      void control.allow;
      // @ts-expect-error The deps' own `automations()` is that same interface.
      void deps.automations().allow;
    };
    expect(pin).toBeTypeOf('function');
  });
});

describe('run_automation on an item', () => {
  const workItem = { repo: 'sprocket/catalog-portal', number: 51, type: 'pr' as const };

  it('passes a work item as the target', async () => {
    await registry.invoke('run_automation', { name: 'review', work_item: workItem }, as('me'));
    expect(trigger).toHaveBeenCalledWith('ws-1', 'review', { sessionId: 'me' }, { workItem });
  });

  it('passes an item key as the target', async () => {
    await registry.invoke('run_automation', { name: 'watch', item_key: 'alice/42' }, as('me'));
    expect(trigger).toHaveBeenCalledWith('ws-1', 'watch', { sessionId: 'me' }, { key: 'alice/42' });
  });

  it('passes no target without either', async () => {
    await registry.invoke('run_automation', { name: 'nightly' }, as('me'));
    expect(trigger).toHaveBeenCalledWith('ws-1', 'nightly', { sessionId: 'me' }, undefined);
  });

  it('refuses both, and starts nothing', async () => {
    await expect(
      registry.invoke(
        'run_automation',
        { name: 'x', work_item: workItem, item_key: 'k' },
        as('me'),
      ),
    ).rejects.toThrow('Pass work_item or item_key, not both.');
    expect(trigger).not.toHaveBeenCalled();
  });

  it('refuses a malformed work item or an empty key before the runner sees it', async () => {
    await expect(
      registry.invoke('run_automation', { name: 'x', work_item: null }, as('me')),
    ).rejects.toThrow(/Invalid arguments/);
    await expect(
      registry.invoke('run_automation', { name: 'x', work_item: 'repo#1' }, as('me')),
    ).rejects.toThrow(/Invalid arguments/);
    await expect(
      registry.invoke('run_automation', { name: 'x', item_key: '' }, as('me')),
    ).rejects.toThrow(/Invalid arguments/);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('builds the target from the known fields only', async () => {
    await registry.invoke(
      'run_automation',
      { name: 'review', work_item: { ...workItem, extra: 'x' } },
      as('me'),
    );
    expect(trigger.mock.calls[0][3]).toStrictEqual({ workItem });
  });

  it('says a check started, not that the event happens, when nothing ran', async () => {
    const result = await registry.invoke('run_automation', { name: 'watch' }, as('me'));
    expect(result.data).toBeNull();
    expect(result.summary).toContain('watch');
    expect(result.summary).toMatch(/check/i);
    expect(result.summary).not.toMatch(/runs when its event happens/);
  });

  it('describes items, and no longer says events run only when they happen', () => {
    const description = registry.get('run_automation')!.description;
    expect(description).not.toMatch(/runs only when that event happens/);
    expect(description).toContain('work_item for a pull request or issue');
    expect(description).toContain('item_key for an item of a poll');
    expect(description).toContain('It waits for the person to approve it.');
    expect(registry.get('list_automations')!.description).toContain(
      'whether it takes an item, of which type',
    );
  });
});

describe('snooze_session and wake_session', () => {
  const snooze = (args: Record<string, unknown>, context: ToolContext = as('me')) =>
    registry.invoke('snooze_session', args, context);

  it('snoozes the caller by default, for a number of minutes, as an agent', async () => {
    const before = Date.now();
    await snooze({ minutes: 30 });
    const [workspaceId, ids, until, opts] = snoozer.snooze.mock.calls[0];
    expect([workspaceId, ids, opts]).toEqual(['ws-1', ['me'], { by: 'agent' }]);
    expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });

  it('reads until as the person’s local time when it has no offset', async () => {
    await snooze({ session_ids: ['ro'], until: '2030-01-02T09:30' });
    expect(snoozer.snooze.mock.calls[0][2]).toBe(new Date(2030, 0, 2, 9, 30).getTime());
  });

  it('takes exactly one of until or minutes, at most 30 days, and refuses a bare date', async () => {
    await expect(snooze({})).rejects.toThrow('exactly one of until or minutes');
    await expect(snooze({ minutes: 5, until: '2030-01-02T09:30' })).rejects.toThrow('exactly one');
    await expect(snooze({ until: '2030-01-02' })).rejects.toThrow('a time as well as a date');
    await expect(snooze({ minutes: 43_201 })).rejects.toThrow(/Invalid arguments/);
  });

  it('reports what main refused, in its words', async () => {
    snoozer.snooze.mockReturnValueOnce({
      applied: [],
      refused: [
        {
          sessionId: 'ro',
          reason: 'needs-you',
          message: 'It is waiting for the person to answer, so it stays in the list.',
        },
      ],
      memento: {},
      until: null,
    });
    const result = await snooze({ session_ids: ['ro'], minutes: 5 });
    expect(result.summary).toBe(
      'Snoozed nothing: It is waiting for the person to answer, so it stays in the list.',
    );
    expect(result.data).toMatchObject({ refused: [{ sessionId: 'ro', reason: 'needs-you' }] });
  });

  it('wakes the caller by default, as an agent', async () => {
    await registry.invoke('wake_session', {}, as('me'));
    expect(snoozer.wake).toHaveBeenCalledWith('ws-1', ['me'], { by: 'agent' });
  });

  it('are offered only to a session with full tools: both change something', () => {
    for (const name of ['snooze_session', 'wake_session']) {
      expect(registry.get(name)).toMatchObject({ mutating: true, automatable: false });
    }
  });
});
