import { describe, expect, it } from 'vitest';
import { diffArgs, parseWorkItemDetails, viewArgs } from './workItemDetails';

const pr = { provider: 'github' as const, repo: 'acme/api', type: 'pr' as const, number: 123 };

describe('GitHub work item details', () => {
    it('always names the item’s own repo, never what the folder resolves to', () => {
        expect(viewArgs(pr)).toEqual([
            'pr', 'view', '123', '--repo', 'acme/api', '--json',
            'title,body,author,state,url,comments,baseRefName,headRefName,files',
        ]);
        expect(viewArgs({ ...pr, type: 'issue' }).slice(0, 5)).toEqual(['issue', 'view', '123', '--repo', 'acme/api']);
        expect(diffArgs(pr)).toEqual(['pr', 'diff', '123', '--repo', 'acme/api']);
    });

    it('reads a pull request with its files and diff', () => {
        const details = parseWorkItemDetails(
            JSON.stringify({
                title: 'Add retries',
                body: 'Retries the client.',
                author: { login: 'alice' },
                state: 'OPEN',
                url: 'https://github.com/acme/api/pull/123',
                comments: [{ author: null, body: 'lgtm' }],
                baseRefName: 'main',
                headRefName: 'retries',
                files: [{ path: 'src/client.ts', additions: 10, deletions: 2 }],
            }),
            'diff --git a/src/client.ts b/src/client.ts\n'
        );
        expect(details).toEqual({
            title: 'Add retries',
            body: 'Retries the client.',
            author: 'alice',
            state: 'open',
            url: 'https://github.com/acme/api/pull/123',
            comments: [{ author: 'ghost', body: 'lgtm' }],
            baseRef: 'main',
            headRef: 'retries',
            files: [{ path: 'src/client.ts', additions: 10, deletions: 2 }],
            diff: 'diff --git a/src/client.ts b/src/client.ts\n',
        });
    });

    it('refuses a reply that is not an item', () => {
        expect(() => parseWorkItemDetails('{"message":"Not Found"}')).toThrow(/Unrecognised reply/);
    });
});
