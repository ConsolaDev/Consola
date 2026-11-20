import { describe, expect, it } from 'vitest';
import { leafCount, visibleNodes } from './fold';
import { entry, ids, keyOf, node } from './entryFixtures';

describe('visibleNodes', () => {
  const nodes = [
    node(entry('a', 'working')),
    node(entry('b', 'working')),
    node(entry('c', 'ready')),
  ];

  it('shows everything when expanded', () => {
    expect(ids(visibleNodes(nodes, false, null))).toEqual(['a', 'b', 'c']);
  });

  it('shows nothing when collapsed with nothing pinned', () => {
    expect(visibleNodes(nodes, true, null)).toEqual([]);
  });

  it('keeps a needs-attention node visible when collapsed', () => {
    const list = [node(entry('a', 'working')), node(entry('child', 'needs-attention'))];
    expect(ids(visibleNodes(list, true, null))).toEqual(['child']);
  });

  it('keeps a done node visible when collapsed', () => {
    const list = [node(entry('a', 'working')), node(entry('finished', 'done'))];
    expect(ids(visibleNodes(list, true, null))).toEqual(['finished']);
  });

  it('keeps the active session visible when collapsed', () => {
    expect(ids(visibleNodes(nodes, true, keyOf('b')))).toEqual(['b']);
  });

  it('keeps a tree visible when the active session is a descendant', () => {
    const list = [
      node(entry('p', 'working'), entry('kid', 'working')),
      node(entry('other', 'working')),
    ];
    expect(ids(visibleNodes(list, true, keyOf('kid')))).toEqual(['p']);
  });

  it('pins a tree by its aggregate: a done or needs-attention child pins its working conductor', () => {
    // Waiting and Done are never collapsed today, but the pin must not rely on that.
    const done = node(entry('p', 'working'), entry('c', 'done'));
    const asks = node(entry('q', 'working'), entry('d', 'needs-attention'));
    const quiet = node(entry('r', 'working'), entry('e', 'ready'));
    expect(ids(visibleNodes([done, asks, quiet], true, null))).toEqual(['p', 'q']);
  });

  it('does not pin on an active key that is nowhere in the shelf', () => {
    expect(visibleNodes(nodes, true, keyOf('elsewhere'))).toEqual([]);
  });

  it("serves a conductor's children: a needs-attention child stays, a working one folds", () => {
    const conductor = node(
      entry('p', 'working'),
      entry('quiet', 'working'),
      entry('asks', 'needs-attention'),
    );
    expect(ids(visibleNodes(conductor.children, true, null))).toEqual(['asks']);
  });

  it('never leaves a working row absent from both the collapsed and expanded views while active', () => {
    const running = node(entry('run', 'working'));
    expect(visibleNodes([running], true, keyOf('run'))).toEqual([running]);
    expect(visibleNodes([running], false, keyOf('run'))).toEqual([running]);
  });
});

describe('leafCount', () => {
  it('counts a conductor beside its children, not the tree as one', () => {
    expect(leafCount([node(entry('p', 'working'), entry('a', 'ready'), entry('b', 'ready'))])).toBe(
      3,
    );
  });

  it('sums plain rows and trees', () => {
    expect(
      leafCount([node(entry('x', 'ready')), node(entry('p', 'ready'), entry('a', 'ready'))]),
    ).toBe(3);
  });

  it('is zero for an empty shelf', () => {
    expect(leafCount([])).toBe(0);
  });
});
