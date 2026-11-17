import { describe, expect, it } from 'vitest';
import { entry, ids, keyOf, node } from './entryFixtures';
import { treeView } from './treeView';

/** A conductor with one child that needs the person: aggregate `needs-attention`. */
const conductor = () => node(entry('p', 'ready'), entry('a', 'needs-attention'), entry('b', 'working'), entry('c', 'working'));
/** The same tree once the child is answered: aggregate `working`. */
const answered = () => node(entry('p', 'ready'), entry('a', 'working'), entry('b', 'working'), entry('c', 'working'));

describe('treeView', () => {
  it('with a child that needs the person, shows only the pinned children and counts the rest', () => {
    const view = treeView(conductor(), undefined, null);
    expect(view.collapsed).toBe(true);
    expect(ids(view.shown)).toEqual(['a']);
    expect(ids(view.left)).toEqual(['b', 'c']);
  });

  it('with an unread result, folds the same way', () => {
    expect(treeView(node(entry('p', 'ready'), entry('a', 'done'), entry('b', 'ready')), undefined, null).collapsed).toBe(true);
  });

  it('elsewhere, shows everyone: the person never asked for less', () => {
    const view = treeView(answered(), undefined, null);
    expect(view.collapsed).toBe(false);
    expect(ids(view.shown)).toEqual(['a', 'b', 'c']);
    expect(view.left).toEqual([]);
  });

  /**
   * The regression the aggregate guards. A conductor whose children have all
   * finished and been seen sits in Done like everything else that has stopped,
   * and folding on the bucket would hide every one of them behind a chip.
   */
  it('shows everyone in a tree that has merely stopped, though it sits in Done', () => {
    const view = treeView(node(entry('p', 'ready'), entry('a', 'ready'), entry('b', 'exited')), undefined, null);
    expect(view.collapsed).toBe(false);
    expect(ids(view.shown)).toEqual(['a', 'b']);
  });

  it('folds back to the preference when the child is answered, with nothing stored in between', () => {
    expect(treeView(conductor(), undefined, null).collapsed).toBe(true);
    expect(treeView(answered(), undefined, null).collapsed).toBe(false);
  });

  it('lets an explicit expand win over the derived fold, and an explicit collapse over the default', () => {
    expect(treeView(conductor(), true, null).left).toEqual([]);
    expect(treeView(answered(), false, null).collapsed).toBe(true);
  });

  it('keeps pinned children visible even when the person collapsed the tree', () => {
    expect(ids(treeView(conductor(), false, null).shown)).toEqual(['a']);
  });

  it('keeps the open child visible while collapsed', () => {
    const view = treeView(conductor(), undefined, keyOf('c'));
    expect(ids(view.shown)).toEqual(['a', 'c']);
    expect(ids(view.left)).toEqual(['b']);
  });
});
