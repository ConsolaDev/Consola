import { describe, expect, it } from 'vitest';
import { entry, ids, keyOf, node } from './entryFixtures';
import { treeView } from './treeView';

const conductor = () => node(entry('p', 'ready'), entry('a', 'needs-attention'), entry('b', 'working'), entry('c', 'working'));

describe('treeView', () => {
  it('in Waiting, shows the parent with only the pinned children and counts the rest', () => {
    const view = treeView(conductor(), 'waiting', undefined, null);
    expect(view.collapsed).toBe(true);
    expect(ids(view.shown)).toEqual(['a']);
    expect(ids(view.left)).toEqual(['b', 'c']);
  });

  it('in Done, folds the same way', () => {
    expect(treeView(node(entry('p', 'ready'), entry('a', 'done'), entry('b', 'ready')), 'done', undefined, null).collapsed).toBe(true);
  });

  it('elsewhere, shows everyone: the person never asked for less', () => {
    const view = treeView(conductor(), 'working', undefined, null);
    expect(view.collapsed).toBe(false);
    expect(ids(view.shown)).toEqual(['a', 'b', 'c']);
    expect(view.left).toEqual([]);
  });

  it('folds back to the preference when the child is answered, with nothing stored in between', () => {
    const waiting = treeView(conductor(), 'waiting', undefined, null);
    const answered = treeView(node(entry('p', 'ready'), entry('a', 'working'), entry('b', 'working'), entry('c', 'working')), 'working', undefined, null);
    expect(waiting.collapsed).toBe(true);
    expect(answered.collapsed).toBe(false);
  });

  it('lets an explicit expand win over the derived fold, and an explicit collapse over the default', () => {
    expect(treeView(conductor(), 'waiting', true, null).left).toEqual([]);
    const collapsed = treeView(conductor(), 'recent', false, null);
    expect(collapsed.collapsed).toBe(true);
    // Pinned children never vanish, even when the person collapsed the tree.
    expect(ids(collapsed.shown)).toEqual(['a']);
  });

  it('keeps the open child visible while collapsed', () => {
    const view = treeView(conductor(), 'waiting', undefined, keyOf('c'));
    expect(ids(view.shown)).toEqual(['a', 'c']);
    expect(ids(view.left)).toEqual(['b']);
  });
});
