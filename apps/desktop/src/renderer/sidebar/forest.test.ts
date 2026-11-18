import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/attention';
import { aggregateAttention, buildForest, membersOf } from './forest';
import { entry, ids, keyOf, node } from './entryFixtures';

describe('buildForest', () => {
  it('makes entries without a parent roots, in input order', () => {
    expect(ids(buildForest([entry('b', 'ready'), entry('a', 'ready')]))).toEqual(['b', 'a']);
  });

  it('nests a child under its conductor', () => {
    const [root] = buildForest([
      entry('c', 'working'),
      entry('k', 'ready', { parent: keyOf('c') }),
    ]);
    expect(ids(root.children)).toEqual(['k']);
  });

  it('nests a child listed before its conductor', () => {
    const roots = buildForest([entry('k', 'ready', { parent: keyOf('c') }), entry('c', 'working')]);
    expect(ids(roots)).toEqual(['c']);
    expect(ids(roots[0].children)).toEqual(['k']);
  });

  it('makes an entry with a dangling parent a root instead of dropping it', () => {
    const roots = buildForest([entry('orphan', 'ready', { parent: keyOf('gone') })]);
    expect(ids(roots)).toEqual(['orphan']);
  });

  it('flattens depth beyond one level under the top conductor', () => {
    const roots = buildForest([
      entry('top', 'working'),
      entry('mid', 'ready', { parent: keyOf('top') }),
      entry('leaf', 'ready', { parent: keyOf('mid') }),
    ]);
    expect(ids(roots)).toEqual(['top']);
    expect(ids(roots[0].children)).toEqual(['mid', 'leaf']);
    expect(roots[0].children.every((child) => child.children.length === 0)).toBe(true);
  });

  it('breaks a parent cycle without losing either entry', () => {
    const roots = buildForest([
      entry('a', 'ready', { parent: keyOf('b') }),
      entry('b', 'ready', { parent: keyOf('a') }),
    ]);
    expect(
      roots
        .flatMap(membersOf)
        .map((e) => e.key)
        .sort(),
    ).toEqual([keyOf('a'), keyOf('b')]);
  });

  it('treats an entry that names itself as its parent as a root', () => {
    expect(ids(buildForest([entry('a', 'ready', { parent: keyOf('a') })]))).toEqual(['a']);
  });

  it('places every entry exactly once', () => {
    const entries = [
      entry('t', 'working'),
      entry('m', 'ready', { parent: keyOf('t') }),
      entry('l', 'ready', { parent: keyOf('m') }),
      entry('o', 'ready', { parent: keyOf('x') }),
    ];
    const placed = buildForest(entries)
      .flatMap(membersOf)
      .map((e) => e.key)
      .sort();
    expect(placed).toEqual(entries.map((e) => e.key).sort());
  });
});

describe('aggregateAttention', () => {
  const all: Attention[] = ['needs-attention', 'done', 'working', 'ready', 'exited', 'settled'];

  it.each(all)('is its own attention for a childless %s node', (attention) => {
    expect(aggregateAttention(node(entry('a', attention)))).toBe(attention);
  });

  it('is the most urgent of the node and its children', () => {
    expect(aggregateAttention(node(entry('p', 'working'), entry('c', 'needs-attention')))).toBe(
      'needs-attention',
    );
    expect(aggregateAttention(node(entry('p', 'settled'), entry('c', 'exited')))).toBe('exited');
  });

  it('answers settled only when every member is settled', () => {
    expect(aggregateAttention(node(entry('p', 'settled'), entry('c', 'settled')))).toBe('settled');
    expect(aggregateAttention(node(entry('p', 'settled'), entry('c', 'ready')))).toBe('ready');
  });

  it('is never empty: a childless node still has an answer, never a default', () => {
    // A node folds [own, ...children], so the set is never empty, and settled (rank 0) is
    // never what an empty fold silently answers.
    expect(aggregateAttention(node(entry('a', 'working')))).not.toBe('settled');
  });
});
