import { describe, expect, it } from 'vitest';
import { entryArgs, openFileArgs, workspaceArg } from './factoryFileArgs';

/*
 * What the renderer hands the factory-file intents (open a file, check again,
 * an entry's agents) is checked before anything reaches the engine or a path:
 * only strings, and a file only as a string or absent (the review's guards no
 * test protected).
 */

const NOT_STRINGS: unknown[] = [undefined, null, 7, {}, ['ws-1'], true];

describe('workspaceArg', () => {
  it('takes a string', () => {
    expect(workspaceArg('ws-1')).toBe('ws-1');
  });

  it.each(NOT_STRINGS)('refuses %j', (value) => {
    expect(() => workspaceArg(value)).toThrow('Workspace id required.');
  });
});

describe('entryArgs', () => {
  it('takes two strings', () => {
    expect(entryArgs('ws-1', 'catalog-review')).toEqual({
      workspaceId: 'ws-1',
      name: 'catalog-review',
    });
  });

  it.each(NOT_STRINGS)('refuses %j for either', (value) => {
    expect(() => entryArgs(value, 'catalog-review')).toThrow(
      'Workspace id and automation name required.',
    );
    expect(() => entryArgs('ws-1', value)).toThrow('Workspace id and automation name required.');
  });
});

describe('openFileArgs', () => {
  it('takes a workspace and a file, or no file (factory.yml)', () => {
    expect(openFileArgs('ws-1', 'agents/reviewer.md')).toEqual({
      workspaceId: 'ws-1',
      file: 'agents/reviewer.md',
    });
    expect(openFileArgs('ws-1', undefined)).toEqual({ workspaceId: 'ws-1', file: undefined });
  });

  it.each(NOT_STRINGS)('refuses %j as the workspace', (value) => {
    expect(() => openFileArgs(value, 'factory.yml')).toThrow('Workspace id required.');
  });

  it.each([null, 7, {}, ['agents/reviewer.md'], true])('refuses %j as the file', (value) => {
    expect(() => openFileArgs('ws-1', value)).toThrow(
      `Not a file of this factory: \`${String(value)}\`.`,
    );
  });
});
