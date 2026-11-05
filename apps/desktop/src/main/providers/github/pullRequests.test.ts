import { describe, expect, it } from 'vitest';
import { parsePullsResponse, pullsEndpoint } from './pullRequests';

function restPull(overrides: Record<string, unknown> = {}) {
    return {
        number: 51,
        state: 'closed',
        merged_at: '2026-10-01T10:00:00Z',
        html_url: 'https://github.com/acme/app/pull/51',
        created_at: '2026-09-20T10:00:00Z',
        head: { sha: 'a'.repeat(40), ref: 'consola/session-1234abcd' },
        extra: 'ignored',
        ...overrides,
    };
}

describe('pullsEndpoint', () => {
    it('addresses a PR by number', () => {
        expect(pullsEndpoint({ repo: 'acme/app', number: 51 })).toBe('repos/acme/app/pulls/51');
    });

    it('filters by owner-qualified head branch, every state, encoded', () => {
        expect(pullsEndpoint({ repo: 'acme/app', headBranch: 'feat/x#1' })).toBe(
            'repos/acme/app/pulls?state=all&per_page=20&head=acme%3Afeat%2Fx%231'
        );
    });

    it('refuses anything that could escape the API path', () => {
        expect(() => pullsEndpoint({ repo: '../../user', number: 1 })).toThrow(/owner\/name/);
        expect(() => pullsEndpoint({ repo: '../escape', number: 1 })).toThrow(/owner\/name/);
        expect(() => pullsEndpoint({ repo: 'acme/..', number: 1 })).toThrow(/owner\/name/);
        expect(pullsEndpoint({ repo: 'socketio/socket.io', number: 1 })).toBe('repos/socketio/socket.io/pulls/1');
        expect(() => pullsEndpoint({ repo: 'acme/app?x=1', number: 1 })).toThrow(/owner\/name/);
        expect(() => pullsEndpoint({ repo: 'acme/app', number: 0 })).toThrow(/number/);
        expect(() => pullsEndpoint({ repo: 'acme/app', headBranch: '' })).toThrow(/head branch/);
    });
});

describe('parsePullsResponse', () => {
    it('maps merged, closed and open states', () => {
        const byNumber = { repo: 'acme/app', number: 51 };
        expect(parsePullsResponse(byNumber, JSON.stringify(restPull()))[0]).toEqual({
            number: 51,
            status: 'merged',
            headOid: 'a'.repeat(40),
            headBranch: 'consola/session-1234abcd',
            fetchRef: 'pull/51/head',
            url: 'https://github.com/acme/app/pull/51',
            createdAt: '2026-09-20T10:00:00Z',
        });
        expect(
            parsePullsResponse(byNumber, JSON.stringify(restPull({ merged_at: null })))[0].status
        ).toBe('closed');
        expect(
            parsePullsResponse(byNumber, JSON.stringify(restPull({ state: 'open', merged_at: null })))[0]
                .status
        ).toBe('open');
    });

    it('sorts a branch lookup newest first', () => {
        const older = restPull({ number: 10, created_at: '2026-01-01T00:00:00Z' });
        const newer = restPull({ number: 20, created_at: '2026-06-01T00:00:00Z' });
        const result = parsePullsResponse(
            { repo: 'acme/app', headBranch: 'b' },
            JSON.stringify([older, newer])
        );
        expect(result.map((pr) => pr.number)).toEqual([20, 10]);
    });

    it('answers an empty branch lookup with no PRs', () => {
        expect(parsePullsResponse({ repo: 'acme/app', headBranch: 'b' }, '[]')).toEqual([]);
    });

    it('throws on shapes it does not recognise rather than reading them as "no PR"', () => {
        const byBranch = { repo: 'acme/app', headBranch: 'b' };
        expect(() => parsePullsResponse(byBranch, '{"message":"Not Found"}')).toThrow(/recognise/);
        expect(() => parsePullsResponse(byBranch, 'not json')).toThrow(/not JSON/);
        expect(() =>
            parsePullsResponse({ repo: 'acme/app', number: 1 }, JSON.stringify(restPull({ state: 'draft' })))
        ).toThrow(/recognise/);
    });
});
