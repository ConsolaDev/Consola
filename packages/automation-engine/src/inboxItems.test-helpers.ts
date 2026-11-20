import type { InboxItemView, ItemRef } from './views';

/** An item's key, in the format the desktop's mapper gives it (`workItemKey`): `github:acme/api:pr:123`. */
export function itemKey(ref: ItemRef): string {
  return `${ref.provider}:${ref.repo.toLowerCase()}:${ref.type}:${ref.number}`;
}

/**
 * An open PR asking the person directly for a review, unless told otherwise:
 * the engine's view of an inbox item, its `key` derived from its final
 * `workItem`.
 */
export function inboxItem(
  fields: Partial<InboxItemView> & { repo?: string; number?: number } = {},
): InboxItemView {
  const { repo = 'acme/api', number = 123, ...rest } = fields;
  const item: Omit<InboxItemView, 'key'> = {
    workItem: { provider: 'github', repo, type: 'pr', number },
    title: 'Add retries',
    author: 'alice',
    roles: ['review-requested-direct'],
    isDraft: false,
    state: 'open',
    url: `https://github.com/${repo}/pull/${number}`,
    ...rest,
  };
  return { ...item, key: itemKey(item.workItem) };
}
