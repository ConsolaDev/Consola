import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test';
import type { LaunchSessionFields } from '../SessionLauncher';
import type { AutomationCapabilities } from '../automations/capabilities';
import { consolaTools, type AutomationControl, type ConsolaToolDeps } from './consolaTools';
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
        makeSession({ id: 'ro', instanceId: 'inst-ro', kind: 'interactive', toolPolicy: 'read-only', hasStarted: true }),
      ],
    }),
  ];
  capabilities = vi.fn(() => ({ grammar: 'g' }) as unknown as AutomationCapabilities);
  saveEntry = vi.fn(async () => ({ name: 'sweep', replaced: false, entry: '- name: sweep', line: 3 }));
  launchSession = vi.fn(async (_workspaceId: string, fields: LaunchSessionFields) =>
    makeSession({ ...fields, id: 'new-1', kind: 'interactive', hasStarted: true } as Partial<Session>)
  );
  const deps: ConsolaToolDeps = {
    cleanup: { previewStale: vi.fn(), cleanupStale: vi.fn(), previewDelete: vi.fn(), deleteSession: vi.fn() },
    getWorkspaces: () => workspaces,
    status: () => 'ready',
    isManagedPath: () => false,
    automations: () => ({ list: () => [], trigger: vi.fn(), capabilities, saveEntry }),
    workItemContext: vi.fn(),
    inbox: () => null,
    launchSession,
  };
  registry = new ToolRegistry();
  consolaTools(deps).forEach((tool) => registry.register(tool));
});

describe('start_session', () => {
  it('opens a session beside the caller: its workspace, harness, model, folder and group', async () => {
    const result = await start({ name: 'Digital twin design', prompt: '/resume-handoff ./handoff.md' });

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
    expect(result.data).toMatchObject({ sessionId: 'new-1', name: 'Digital twin design', forked: false });
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
    const result = await start({ name: 'Digital twin design', prompt: 'Carry on only the twin thread.', fork: true });

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
      start({ name: 'x', prompt: 'go', fork: true, scope_path: '/repos/parent' })
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
      /not one of this workspace’s folders/
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
      start({ name: 'x', prompt: 'go' }, {
        caller: { kind: 'automation', automation: 'sweep' },
        scope: { workspaceIds: 'all', excludeSessionIds: [] },
      })
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
    const result = await registry.invoke('save_automation', { entry: '- name: sweep', replace: true }, as('me'));
    expect(saveEntry).toHaveBeenCalledWith('ws-1', '- name: sweep', {
      replace: true,
      by: { sessionId: 'me', sessionName: 'Code review cost sizing' },
    });
    expect(result.data).toMatchObject({ name: 'sweep', replaced: false });
    expect(registry.get('save_automation')).toMatchObject({ mutating: true, automatable: false, fullToolsOnly: true });
  });

  it('does not replace unless asked, and needs an entry', async () => {
    await registry.invoke('save_automation', { entry: '- name: sweep' }, as('me'));
    expect(saveEntry.mock.calls[0][2].replace).toBe(false);
    await expect(registry.invoke('save_automation', { entry: '' }, as('me'))).rejects.toThrow(/Invalid arguments/);
  });
});
