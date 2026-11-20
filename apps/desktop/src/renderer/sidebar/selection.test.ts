import { describe, expect, it } from 'vitest';
import { entry, keyOf, node } from './entryFixtures';
import { drawnOrder, pruneSelection, rangeBetween, selectionGesture } from './selection';

describe('drawnOrder', () => {
  it('lists the list, then each shelf, each conductor followed by the children it shows', () => {
    const lead = node(entry('lead', 'done'), entry('kid1', 'done'), entry('kid2', 'ready'));
    const order = drawnOrder(
      [[node(entry('a', 'ready')), lead], [node(entry('busy', 'working'))], [], []],
      (tree) => (tree === lead ? [tree.children[0]] : tree.children),
    );
    expect(order).toEqual([keyOf('a'), keyOf('lead'), keyOf('kid1'), keyOf('busy')]);
  });
});

describe('rangeBetween', () => {
  const order = ['a', 'b', 'c', 'd'].map(keyOf);

  it('selects from the anchor to the row, either way round', () => {
    expect(rangeBetween(order, keyOf('b'), keyOf('d'))).toEqual(['b', 'c', 'd'].map(keyOf));
    expect(rangeBetween(order, keyOf('d'), keyOf('b'))).toEqual(['b', 'c', 'd'].map(keyOf));
  });

  it('is the row alone with no anchor or one no longer drawn, and nothing for a row not drawn', () => {
    expect(rangeBetween(order, null, keyOf('c'))).toEqual([keyOf('c')]);
    expect(rangeBetween(order, keyOf('gone'), keyOf('c'))).toEqual([keyOf('c')]);
    expect(rangeBetween(order, keyOf('a'), keyOf('gone'))).toEqual([]);
  });
});

describe('pruneSelection', () => {
  it('keeps only what is drawn, in drawn order', () => {
    expect(pruneSelection(['c', 'gone', 'a'].map(keyOf), ['a', 'b', 'c'].map(keyOf))).toEqual(
      ['a', 'c'].map(keyOf),
    );
  });
});

describe('selectionGesture', () => {
  const click = (keys: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...keys,
  });

  it('toggles with ⌘ on a Mac and Ctrl elsewhere, and ranges with Shift', () => {
    expect(selectionGesture(click({ metaKey: true }), true)).toBe('toggle');
    expect(selectionGesture(click({ ctrlKey: true }), true)).toBeNull();
    expect(selectionGesture(click({ ctrlKey: true }), false)).toBe('toggle');
    expect(selectionGesture(click({ shiftKey: true }), true)).toBe('range');
    expect(selectionGesture(click({}), true)).toBeNull();
  });
});
