import { describe, expect, it } from 'vitest';
import {
  CONSOLA_NAMESPACE as ENGINE_NAMESPACE,
  agentToolContext,
  describeError as engineDescribeError,
  fillActionPlaceholders,
  firstActionFor,
  fallbackWorkItemTitle as engineFallbackTitle,
  firstScope,
  type ToolsPort,
} from '@consola/automation-engine';
import { describeError } from '../describeError';
import { CONSOLA_NAMESPACE, ToolRegistry, agentContext } from '../tools/Tool';
import { defaultActionFor, type WorkItemAction } from '../../shared/workItemActions';
import { fallbackWorkItemTitle, substitutePlaceholders } from '../../shared/workItemPrompt';
import { primaryScope, type Scope, type Session, type Workspace } from '../../shared/workspace';
import { workItemKey, type InboxItem } from '../../shared/workItems';
import {
  sessionRecord,
  toInboxItemView,
  toItemSnapshot,
  toWorkItemRef,
  toWorkspaceView,
} from './engineViews';

// Compile-time check: the registry satisfies the engine's port with no adapter.
const _ports: ToolsPort = new ToolRegistry();
void _ports;

/** An open PR asking the person directly for a review: the desktop's own record, which `toInboxItemView` maps. */
function inboxItem(
  fields: Partial<InboxItem> & { repo?: string; number?: number } = {},
): InboxItem {
  const { repo = 'acme/api', number = 123, ...rest } = fields;
  return {
    workItem: { provider: 'github', repo, type: 'pr', number },
    title: 'Add retries',
    author: 'alice',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    reviewDecision: 'review-required',
    commentCount: 0,
    updatedAt: '2026-11-04T08:00:00Z',
    url: `https://github.com/${repo}/pull/${number}`,
    ...rest,
  };
}

const scope = (id: string): Scope => ({
  id,
  name: id,
  path: `/code/${id}`,
  isGitRepo: true,
  createdAt: 1,
});

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  name: `Session ${id}`,
  workspaceId: 'w1',
  instanceId: `inst-${id}`,
  claudeSessionId: `claude-${id}`,
  hasStarted: true,
  harnessId: 'claude',
  scopeId: 's1',
  kind: 'interactive',
  createdAt: 10,
  lastActiveAt: 20,
  ...extra,
});

const action = (id: string, appliesTo: Array<'pr' | 'issue'>): WorkItemAction => ({
  id,
  name: `Action ${id}`,
  appliesTo,
  prompt: `Do ${id}`,
});

const workspace = (fields: Partial<Workspace> = {}): Workspace => ({
  id: 'w1',
  name: 'Sprocket',
  defaultHarnessId: 'claude',
  scopes: [scope('s1'), scope('s2')],
  groups: [],
  provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
  actions: [action('a', ['pr']), action('b', ['issue']), action('c', ['pr', 'issue'])],
  sectionDefaults: {},
  sessions: [],
  createdAt: 1,
  updatedAt: 2,
  ...fields,
});

describe('the mappers', () => {
  it('maps a workspace with two sessions, one on #51', () => {
    const ref = {
      provider: 'github' as const,
      repo: 'sprocket/catalog-portal',
      type: 'pr' as const,
      number: 51,
    };
    const view = toWorkspaceView(
      workspace({
        sessions: [
          session('one', {
            workItem: ref,
            workItemAction: 'Review',
            toolPolicy: 'read-only',
            automation: { name: 'reviews', runId: 'r1' },
            cwd: '/wt',
          }),
          session('two'),
        ],
      }),
    );
    expect(view.provider).toEqual({ id: 'github', accountLogin: 'JaviDev', org: 'sprocket' });
    expect(view.scopes).toEqual([
      { id: 's1', name: 's1', path: '/code/s1' },
      { id: 's2', name: 's2', path: '/code/s2' },
    ]);
    expect(view.actions[2]).toEqual({
      name: 'Action c',
      appliesTo: ['pr', 'issue'],
      prompt: 'Do c',
    });
    expect(view.sessions[0]).toEqual({
      id: 'one',
      workspaceId: 'w1',
      name: 'Session one',
      scopeId: 's1',
      harnessId: 'claude',
      claudeSessionId: 'claude-one',
      cwd: '/wt',
      createdAt: 10,
      automation: { name: 'reviews', runId: 'r1' },
      workItemKey: 'github:sprocket/catalog-portal:pr:51',
      workItemAction: 'Review',
      toolPolicy: 'read-only',
    });
    expect(view.sessions[1].workItemKey).toBeUndefined();
    expect('workItemKey' in view.sessions[1]).toBe(false);
  });

  it("maps a step session's provenance", () => {
    const provenance = {
      name: 'review-assigned-prs',
      runId: 'r1',
      step: { id: 'review', attempt: 2 },
    };
    const [view] = toWorkspaceView(
      workspace({ sessions: [session('one', { automation: provenance })] }),
    ).sessions;
    expect(view.automation).toEqual(provenance);
    // A copy: the view never hands the engine the record's own object.
    expect(view.automation?.step).not.toBe(provenance.step);
  });

  it('leaves the provider off an unbound workspace', () => {
    expect('provider' in toWorkspaceView(workspace({ provider: undefined }))).toBe(false);
  });

  it('keys an item by workItemKey', () => {
    const item = inboxItem({ repo: 'Sprocket/Catalog-Portal', number: 51 });
    const view = toInboxItemView(item);
    expect(view.key).toBe(workItemKey(item.workItem));
    expect(view.key).toBe('github:sprocket/catalog-portal:pr:51');
    expect(view).toMatchObject({
      title: item.title,
      author: item.author,
      url: item.url,
      roles: item.roles,
      isDraft: false,
      state: 'open',
    });
  });

  it('maps a snapshot, error included', () => {
    const snap = toItemSnapshot({
      workspaceId: 'w1',
      items: [inboxItem()],
      fetchedAt: 5,
      error: 'offline',
    });
    expect(snap).toMatchObject({ workspaceId: 'w1', fetchedAt: 5, error: 'offline' });
    expect(snap.items[0].key).toBe('github:acme/api:pr:123');
    expect('error' in toItemSnapshot({ workspaceId: 'w1', items: [], fetchedAt: 0 })).toBe(false);
  });

  it('finds the session record across workspaces', () => {
    const target = session('x');
    const all = [workspace({ id: 'w0' }), workspace({ sessions: [target] })];
    expect(sessionRecord(all, 'x')).toBe(target);
    expect(sessionRecord(all, 'nope')).toBeUndefined();
  });

  it('turns an engine ref back, refusing an unknown provider', () => {
    expect(toWorkItemRef({ provider: 'github', repo: 'a/b', type: 'issue', number: 3 })).toEqual({
      provider: 'github',
      repo: 'a/b',
      type: 'issue',
      number: 3,
    });
    expect(() =>
      toWorkItemRef({ provider: 'toString', repo: 'a/b', type: 'pr', number: 1 }),
    ).toThrow('Unknown provider "toString".');
  });
});

describe('parity: the engine copies equal their desktop originals', () => {
  const cases = [
    { type: 'pr' as const, number: 51, repo: 'sprocket/catalog-portal' },
    { type: 'issue' as const, number: 87, repo: 'sprocket/forum-admin' },
  ];
  const templates = [
    '{{number}} {{ repo }} {{title}} {{url}} {{type}} {{other}}',
    '/review',
    '{{number}}{{number}} {{ title }}',
  ];

  describe.each(cases)('fillActionPlaceholders on a $type', (c) => {
    it.each(templates)('%s', (template) => {
      const item = inboxItem({ repo: c.repo, number: c.number, title: 'Add {{retries}}' });
      item.workItem.type = c.type;
      const view = toInboxItemView(item);
      expect(fillActionPlaceholders(template, view)).toBe(
        substitutePlaceholders(template, item.workItem, item),
      );
    });
  });

  it('agentToolContext equals agentContext, the error included', () => {
    const all = [
      workspace({ id: 'w1', sessions: [session('a')] }),
      workspace({ id: 'w2', sessions: [session('b', { workspaceId: 'w2' })] }),
    ];
    const views = all.map(toWorkspaceView);
    for (const id of ['a', 'b']) expect(agentToolContext(id, views)).toEqual(agentContext(id, all));
    let original: unknown;
    let copy: unknown;
    try {
      agentContext('missing', all);
    } catch (e) {
      original = e;
    }
    try {
      agentToolContext('missing', views);
    } catch (e) {
      copy = e;
    }
    expect(copy).toBeInstanceOf(Error);
    expect((copy as Error).message).toBe((original as Error).message);
  });

  it.each([
    ['pr', ['a', 'b', 'c']],
    ['issue', ['a', 'b', 'c']],
    ['pr', ['b']],
    ['issue', ['a']],
    ['pr', []],
  ] as const)('firstActionFor(%s, %j) names what defaultActionFor does', (type, ids) => {
    const actions = ids.map((id) =>
      action(id, id === 'a' ? ['pr'] : id === 'b' ? ['issue'] : ['pr', 'issue']),
    );
    const views = toWorkspaceView(workspace({ actions })).actions;
    expect(firstActionFor(views, type)?.name).toBe(defaultActionFor(actions, type)?.name);
  });

  it.each([[['s1', 's2']], [['s2']], [[]]])(
    'firstScope on scopes %j equals primaryScope',
    (ids) => {
      const ws = workspace({ scopes: ids.map(scope) });
      expect(firstScope(toWorkspaceView(ws))?.id).toBe(primaryScope(ws)?.id);
    },
  );

  it.each([new Error('boom'), 'plain', 42, null, undefined, { a: 1 }])(
    'describeError(%j)',
    (value) => {
      expect(engineDescribeError(value)).toBe(describeError(value));
    },
  );

  it.each([
    { type: 'pr' as const, number: 51 },
    { type: 'issue' as const, number: 87 },
  ])("fallbackWorkItemTitle equals the desktop's for a $type", ({ type, number }) => {
    expect(engineFallbackTitle({ type, number })).toBe(
      fallbackWorkItemTitle({ provider: 'github', repo: 'sprocket/catalog-portal', type, number }),
    );
  });

  it('CONSOLA_NAMESPACE is the same constant', () => {
    expect(ENGINE_NAMESPACE).toBe(CONSOLA_NAMESPACE);
  });
});
