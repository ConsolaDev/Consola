import type { InboxItem } from '../../shared/workItems';

/** An open PR asking the person directly for a review, unless told otherwise. */
export function inboxItem(fields: Partial<InboxItem> & { repo?: string; number?: number } = {}): InboxItem {
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
