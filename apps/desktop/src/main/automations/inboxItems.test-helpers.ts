import type { InboxItemView, ItemRef } from '@consola/automation-engine';
import type { InboxItem } from '../../shared/workItems';

/** An item's key, in the format the desktop's mapper gives it (`workItemKey`): `github:acme/api:pr:123`. */
export function itemKey(ref: ItemRef): string {
    return `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`;
}

/**
 * An open PR asking the person directly for a review, unless told otherwise.
 * It is the engine's view of the item, its `key` included, and the desktop's
 * record at once: the runner reads it as the view, and `engineViews.test.ts`
 * maps it as the record.
 */
export function inboxItem(
    fields: Partial<InboxItem> & { repo?: string; number?: number } = {}
): InboxItem & InboxItemView {
    const { repo = 'acme/api', number = 123, ...rest } = fields;
    const item: InboxItem = {
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
    return { ...item, key: itemKey(item.workItem) };
}
