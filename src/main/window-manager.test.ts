import { describe, expect, it } from 'vitest';
import { dedupeByWorkspace } from './window-manager';

describe('dedupeByWorkspace', () => {
  it('keeps only the first entry for a repeated workspace id', () => {
    const entries = [
      { workspaceId: 'a', bounds: 1 },
      { workspaceId: 'a', bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual([{ workspaceId: 'a', bounds: 1 }]);
  });

  it('leaves distinct workspace ids alone', () => {
    const entries = [
      { workspaceId: 'a', bounds: 1 },
      { workspaceId: 'b', bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual(entries);
  });

  it('never collapses windows with no workspace — several Home windows is normal', () => {
    const entries = [
      { workspaceId: null, bounds: 1 },
      { workspaceId: null, bounds: 2 },
    ];

    expect(dedupeByWorkspace(entries)).toEqual(entries);
  });

  it('passes an empty layout through unchanged', () => {
    expect(dedupeByWorkspace([])).toEqual([]);
  });
});
