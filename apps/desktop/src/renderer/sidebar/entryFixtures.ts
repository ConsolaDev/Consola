import type { Attention } from '../../shared/attention';
import { SESSION_FACET_DOMAIN } from './entry';
import type { Entry } from './entry';
import { buildForest } from './forest';
import type { TreeNode } from './forest';

/** An entry keyed `session:<id>`, with only what a test names. */
export function entry(id: string, attention: Attention, rest: Partial<Entry> = {}): Entry {
  return {
    key: `session:${id}`,
    kind: 'session',
    attention,
    createdAt: 0,
    activityAt: 0,
    labels: [],
    facets: {},
    facetDomain: SESSION_FACET_DOMAIN,
    ...rest,
  };
}

export const keyOf = (id: string): Entry['key'] => `session:${id}`;

/** A node with the given children, bypassing buildForest. */
export function node(e: Entry, ...children: Entry[]): TreeNode {
  return { entry: e, children: children.map((child) => ({ entry: child, children: [] })) };
}

export const forest = (entries: Entry[]): TreeNode[] => buildForest(entries);

export const ids = (nodes: TreeNode[]): string[] =>
  nodes.map((n) => n.entry.key.replace('session:', ''));
