import { describe, expect, it } from 'vitest';
import type { CheckoutInfo } from '../../shared/sessionCheckout';
import type { HarnessModel } from '../../shared/types';
import { createSessionRecord, createWorkspaceRecord, type Session } from '../../shared/workspace';
import type { RemovedWorktree } from '../../shared/worktreeCleanup';
import { tabFactsFor } from '../sidePanel/tabKinds';
import {
  folderLine,
  harnessLine,
  offersFixInSession,
  policyLine,
  splitForMiddle,
} from './environment';

const workspace = createWorkspaceRecord('catalog-portal', '/repos/catalog-portal', true);
const session = createSessionRecord({
  name: 'Paginate the catalog search',
  workspaceId: workspace.id,
  instanceId: 'i1',
  harnessId: 'default',
  scopeId: workspace.scopes[0].id,
});
const removedWorktree: RemovedWorktree = {
  path: '/repos/catalog-portal-7f3a',
  mainRepo: '/repos/catalog-portal',
  commit: 'a'.repeat(40),
  branch: 'feat/search-pagination',
  keepRef: 'refs/consola/worktrees/catalog-portal-7f3a',
  trigger: 'settled',
  removedAt: 0,
};

const main: CheckoutInfo = {
  kind: 'main',
  root: '/repos/catalog-portal',
  mainCheckout: '/repos/catalog-portal',
  branch: 'main',
};
const worktree: CheckoutInfo = {
  kind: 'worktree',
  root: '/repos/catalog-portal-7f3a',
  mainCheckout: '/repos/catalog-portal',
  branch: 'feat/search-pagination',
};

const factsOf = (shown: Session, checkout?: CheckoutInfo) =>
  tabFactsFor(workspace, shown, checkout);

describe('folderLine', () => {
  it('folderLine names the checkout, or says the worktree was removed', () => {
    const inWorktree = { ...session, cwd: '/repos/catalog-portal-7f3a' };
    expect(folderLine(factsOf(inWorktree, worktree))).toEqual({
      kind: 'folder',
      label: 'Worktree',
      path: '/repos/catalog-portal-7f3a',
    });
    expect(folderLine(factsOf(session, main))).toEqual({
      kind: 'folder',
      label: 'Main checkout',
      path: '/repos/catalog-portal',
    });
    expect(folderLine(factsOf({ ...session, cwd: '/notes' }, { kind: 'none' }))).toEqual({
      kind: 'folder',
      label: 'Folder',
      path: '/notes',
    });
    // Git has not answered yet: the path, with no word for what it is.
    expect(folderLine(factsOf(session, undefined))).toEqual({
      kind: 'folder',
      label: null,
      path: '/repos/catalog-portal',
    });
    expect(folderLine(factsOf({ ...inWorktree, removedWorktree }, worktree))).toEqual({
      kind: 'removed',
    });
    expect(folderLine({ session, checkout: undefined, checkoutPath: undefined })).toBeNull();
  });

  it('folderLine follows the agent', () => {
    const moved = { ...session, agentCwd: '/repos/catalog-portal-7f3a' };
    expect(folderLine(factsOf(moved, worktree))).toEqual({
      kind: 'folder',
      label: 'Worktree',
      path: '/repos/catalog-portal-7f3a',
    });
  });
});

describe('harnessLine', () => {
  const sonnet: HarnessModel = {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    description: 'Fast and capable',
  };

  it('harnessLine prefers the CLI’s own account and model names', () => {
    // The capability account, while the CLI says it is signed in.
    expect(
      harnessLine({
        driverLabel: 'Claude Code',
        harnessName: 'Stub',
        capabilityAccount: { signedIn: true, emailAddress: 'javidev@sprocket.example' },
        healthAccount: { emailAddress: 'old@sprocket.example' },
      }),
    ).toEqual({ label: 'Claude Code · Stub', account: 'javidev@sprocket.example' });

    // Else the account read from the config folder, by email, else by name.
    expect(
      harnessLine({
        driverLabel: 'Claude Code',
        harnessName: 'Stub',
        capabilityAccount: { signedIn: false },
        healthAccount: { emailAddress: 'javidev@sprocket.example', displayName: 'JaviDev' },
      }).account,
    ).toBe('javidev@sprocket.example');
    expect(
      harnessLine({ driverLabel: 'Claude Code', healthAccount: { displayName: 'JaviDev' } }),
    ).toEqual({ label: 'Claude Code', account: 'JaviDev' });

    // A model the CLI lists, by the name it gives it.
    expect(
      harnessLine({ driverLabel: 'Claude Code', model: 'sonnet', models: [sonnet] }).model,
    ).toBe('Sonnet 4.5');

    // One it does not list, said the way a person says it.
    expect(
      harnessLine({ driverLabel: 'Claude Code', model: 'claude-opus-4-6', models: [sonnet] }).model,
    ).toBe('Opus 4.6');
    expect(harnessLine({ driverLabel: 'Codex', model: 'claude-opus-4-6' }).model).toBe('Opus 4.6');

    // Nothing known: the driver alone.
    expect(harnessLine({ driverLabel: 'Codex' })).toEqual({ label: 'Codex' });
  });
});

describe('policyLine', () => {
  it('policyLine names the automation that started a read-only session, and none for full tools', () => {
    expect(
      policyLine({
        ...session,
        toolPolicy: 'read-only',
        automation: { name: 'Nightly review', runId: 'run-1' },
      }),
    ).toBe('Read-only · started by Nightly review');
    expect(policyLine({ ...session, toolPolicy: 'read-only' })).toBe('Read-only');
    expect(policyLine(session)).toBeNull();
  });

  const AUTO = { name: 'ui-bug-to-pr', runId: 'run-1', step: { id: 'fix', attempt: 1 } };
  const grantsOn = (isolation: 'host' | 'sandbox') => ({
    driverId: 'claude' as const,
    servers: [],
    skills: [],
    strict: true,
    allowedTools: [],
    environment: { name: isolation === 'sandbox' ? 'sandboxed' : 'mine', isolation, envNames: [] },
  });

  it.each([
    ['sandbox', 'writes · sandboxed · started by ui-bug-to-pr'],
    ['host', 'writes · host, a convention · started by ui-bug-to-pr'],
  ] as const)('names a write step on %s (slice 3-B)', (isolation, line) => {
    expect(policyLine({ toolPolicy: 'write', automation: AUTO, grants: grantsOn(isolation) })).toBe(
      line,
    );
    expect(policyLine({ toolPolicy: 'edit', automation: AUTO, grants: grantsOn(isolation) })).toBe(
      line,
    );
  });

  it('says only the weaker claim for a write step whose grants name no environment', () => {
    expect(policyLine({ toolPolicy: 'write', automation: AUTO })).toBe(
      'writes · host, a convention · started by ui-bug-to-pr',
    );
  });
});

describe('offersFixInSession', () => {
  it('the work item pane pastes a fix only into a session with full tools (slice 3-B)', () => {
    expect(offersFixInSession({})).toBe(true);
    for (const toolPolicy of ['read-only', 'edit', 'write'] as const)
      expect(offersFixInSession({ toolPolicy })).toBe(false);
  });
});

describe('splitForMiddle', () => {
  it('splitForMiddle keeps the end', () => {
    expect(splitForMiddle('~/.consola/worktrees/catalog-portal-7f3a', 15)).toEqual([
      '~/.consola/worktrees/cata',
      'log-portal-7f3a',
    ]);
    expect(splitForMiddle('~/.consola/worktrees/catalog-portal-7f3a', 12)).toEqual([
      '~/.consola/worktrees/catalog',
      '-portal-7f3a',
    ]);
    expect(splitForMiddle('~/notes', 12)).toEqual(['', '~/notes']);
    expect(splitForMiddle('~/notes', 7)).toEqual(['', '~/notes']);
  });
});
