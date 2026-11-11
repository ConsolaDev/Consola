import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { makeWorkspace } from '../conductor/ConductorTools.test';
import { startAssistantSession, type AssistantStartDeps, type AssistantStartRequest } from './startSession';

const prItem = { repo: 'sprocket/catalog-portal', number: 4229, type: 'pr' as const };
let workspace: Workspace;
let worktreeDir: string;
let deps: AssistantStartDeps;
const launchSession = () => deps.launchSession as unknown as Mock;

beforeEach(() => {
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-assistant-start-'));
  fs.mkdirSync(path.join(worktreeDir, '.git'));
  workspace = makeWorkspace({
    defaultHarnessId: 'work',
    provider: { id: 'github', accountLogin: 'octocat' },
  });
  deps = {
    resolveDriver: () => ({}) as GitProviderDriver,
    resolveRepo: () => '/repos/app/catalog-portal',
    worktreePathFor: () => worktreeDir,
    ensureWorktree: vi.fn(async () => worktreeDir),
    refreshWorktree: vi.fn(async () => true),
    worktreeInUse: vi.fn(() => false),
    composeEnv: async () => ({}),
    restoreGroup: vi.fn(),
    launchSession: vi.fn(async (_id: string, fields: { name: string }) => ({ id: 's-1', name: fields.name }) as Session),
  };
});

const start = (request: Partial<AssistantStartRequest> = {}) =>
  startAssistantSession(deps, workspace, { name: 'x', prompt: 'p', ...request });

describe('startAssistantSession', () => {
  it('runs a pull request in its Consola worktree, linked, on the default harness, full tools by default', async () => {
    const { mode } = await start({ name: '#4229 review', prompt: 'review it', workItem: prItem });
    expect(mode).toBe('full-tools');
    expect(deps.launchSession).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        name: '#4229 review',
        nameIsUserSet: true,
        harnessId: 'work',
        kind: 'interactive',
        cwd: worktreeDir,
        scopeId: 'scope-1',
        workItem: { provider: 'github', ...prItem },
        initialPrompt: 'review it',
      })
    );
    expect(launchSession().mock.calls[0][1]).not.toHaveProperty('toolPolicy');
    expect(launchSession().mock.calls[0][1]).not.toHaveProperty('model');
  });

  it('starts it read-only and unattended when the workspace says so, whatever the Assistant asks', async () => {
    workspace.assistantItemMode = 'read-only';
    const { mode } = await start({ workItem: prItem, readOnly: false });
    expect(mode).toBe('read-only');
    expect(deps.launchSession).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ toolPolicy: 'read-only', unattended: true, initialPrompt: 'p' })
    );
  });

  it('lets the Assistant pick only in assistant-picks mode', async () => {
    workspace.assistantItemMode = 'assistant-picks';
    expect((await start({ workItem: prItem, readOnly: true })).mode).toBe('read-only');
    expect((await start({ workItem: prItem })).mode).toBe('full-tools');
    workspace.assistantItemMode = 'full-tools';
    expect((await start({ workItem: prItem, readOnly: true })).mode).toBe('full-tools');
  });

  it('never restricts a session that has no work item', async () => {
    workspace.assistantItemMode = 'read-only';
    const { mode } = await start();
    expect(mode).toBe('full-tools');
    expect(launchSession().mock.calls[0][1]).not.toHaveProperty('toolPolicy');
  });

  it('runs without an item in a scope folder, or a folder inside it', async () => {
    await start({ scopePath: '/repos/parent', cwd: '/repos/parent/web' });
    expect(deps.launchSession).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ scopeId: 'scope-2', cwd: '/repos/parent/web' })
    );
  });

  it('defaults to the first scope', async () => {
    await start();
    const fields = launchSession().mock.calls[0][1];
    expect(fields.scopeId).toBe('scope-1');
    expect(fields).not.toHaveProperty('cwd');
  });

  it('refuses what is outside this workspace', async () => {
    await expect(start({ scopePath: '/etc' })).rejects.toThrow('/etc is not one of this workspace’s folders.');
    await expect(start({ scopePath: '/repos/app', cwd: '/repos/other' })).rejects.toThrow('cwd must be inside /repos/app.');
    await expect(start({ group: 'nope' })).rejects.toThrow('No group "nope" in this workspace.');
    await expect(start({ workItem: { repo: 'not a repo', number: 1, type: 'pr' } })).rejects.toThrow(
      /Not a valid pull request or issue/
    );
    await expect(start({ workItem: prItem, scopePath: '/repos/app' })).rejects.toThrow(
      'A work item runs in its own worktree; leave out scope_path and cwd.'
    );
    expect(deps.launchSession).not.toHaveBeenCalled();
  });

  it('puts it in a group by name or id, restoring an archived one', async () => {
    await start({ group: 'Symbalance-API' });
    expect(deps.launchSession).toHaveBeenLastCalledWith('ws-1', expect.objectContaining({ groupId: 'grp-1' }));
    workspace.groups[0].archivedAt = 5;
    await start({ group: 'grp-1' });
    expect(deps.launchSession).toHaveBeenLastCalledWith('ws-1', expect.objectContaining({ groupId: 'grp-1' }));
    expect(deps.restoreGroup).toHaveBeenCalledWith('ws-1', 'grp-1');
  });

  it('lets a harness that cannot enforce read-only refuse the launch', async () => {
    workspace.assistantItemMode = 'read-only';
    launchSession().mockRejectedValue(new Error('cannot restrict'));
    await expect(start({ workItem: prItem })).rejects.toThrow('cannot restrict');
  });
});
