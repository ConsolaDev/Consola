import type { Session, Workspace } from '../../shared/workspace';

/** v6 session fixture. Cast tolerates fields v6 adds beyond this plan's use. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cond-1',
    name: 'conductor',
    workspaceId: 'ws-1',
    instanceId: 'inst-cond',
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-1',
    groupId: 'grp-1',
    kind: 'conductor',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  };
}

export function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-1', name: 'app', path: '/repos/app', isGitRepo: true, createdAt: 0 },
      { id: 'scope-2', name: 'parent', path: '/repos/parent', isGitRepo: false, createdAt: 0 },
    ],
    groups: [{ id: 'grp-1', name: 'symbalance-api', createdAt: 0 }],
    sessions: [makeSession()],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Workspace;
}
