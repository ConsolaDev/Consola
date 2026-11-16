import { describe, expect, it } from 'vitest';
import type { ItemRef } from '@consola/automation-engine';
import type { Workspace } from '../../shared/workspace';
import { workItemKey, workItemUrl } from '../../shared/workItems';
import { GitHubDriver } from '../providers/github/GitHubDriver';
import { desktopWorkItemPort } from './workItemPort';
import { toWorkItemRef } from './engineViews';

const ref: ItemRef = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };

function workspace(provider: Workspace['provider']): Workspace {
    return { id: 'ws-1', ...(provider ? { provider } : {}) } as Workspace;
}

function port(overrides: { resolveRepo?: (w: Workspace, repo: string) => string | null; workspaces?: Workspace[] } = {}) {
    const github = new GitHubDriver(() => ({ PATH: '' }));
    const workspaces = overrides.workspaces ?? [workspace({ id: 'github', accountLogin: 'JaviDev' })];
    return desktopWorkItemPort({
        getWorkspace: (id) => workspaces.find((candidate) => candidate.id === id),
        resolveRepo: overrides.resolveRepo ?? (() => null),
        driverFor: (connection) => (connection === 'github' ? github : null),
    });
}

describe('desktopWorkItemPort', () => {
    it('keyOf equals workItemKey', () => {
        expect(port().keyOf(ref)).toBe(workItemKey(toWorkItemRef(ref)));
    });

    it('urlOf equals workItemUrl', () => {
        expect(port().urlOf(ref)).toBe(workItemUrl(toWorkItemRef(ref)));
    });

    it('parses GitHub URLs through the driver', () => {
        const items = port();
        expect(items.canParseUrls('github')).toBe(true);
        expect(items.parseUrl('github', 'https://github.com/sprocket/catalog-portal/pull/51')).toEqual(ref);
        expect(items.parseUrl('github', 'https://example.com/x')).toBeNull();
    });

    it('an unknown connection parses nothing and cannot parse URLs', () => {
        const items = port();
        expect(items.canParseUrls('nowhere')).toBe(false);
        expect(items.parseUrl('nowhere', 'https://github.com/sprocket/catalog-portal/pull/51')).toBeNull();
    });

    it('inWorkspace follows resolveRepo, and is false for an unbound workspace', () => {
        const cloned = port({ resolveRepo: () => '/work/catalog-portal' });
        expect(cloned.inWorkspace('ws-1', ref)).toBe(true);
        expect(port({ resolveRepo: () => null }).inWorkspace('ws-1', ref)).toBe(false);
        const unbound = port({ resolveRepo: () => '/work/catalog-portal', workspaces: [workspace(undefined)] });
        expect(unbound.inWorkspace('ws-1', ref)).toBe(false);
        expect(cloned.inWorkspace('missing', ref)).toBe(false);
    });
});
