import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateFile } from '../ports';
import { ServerGroupLedger, type ServerGroupsFile } from './serverGroups';

function memory(): StateFile<ServerGroupsFile> & { stored: ServerGroupsFile | null } {
  const file = {
    stored: null as ServerGroupsFile | null,
    read: () => (file.stored === null ? null : structuredClone(file.stored)),
    write: (value: ServerGroupsFile) => {
      file.stored = structuredClone(value);
    },
  };
  return file;
}
const GROUP = { pgid: 4242, startedAt: 'Mon Nov 16 08:00:00 2026' };
const OTHER = { pgid: 4243, startedAt: 'Mon Nov 16 08:01:00 2026' };

afterEach(() => vi.restoreAllMocks());

describe('ServerGroupLedger (5a-2 Task 9)', () => {
  it('adds, lists and removes groups, through its file', () => {
    const file = memory();
    const ledger = new ServerGroupLedger(file);
    ledger.add(GROUP, 'ws-1/brief/slack', '2026-11-16T08:00:00.000Z');
    ledger.add(OTHER, 'ws-1/brief/slack', '2026-11-16T08:01:00.000Z');
    expect(file.stored).toEqual({
      version: 1,
      groups: [
        { ...GROUP, for: 'ws-1/brief/slack', at: '2026-11-16T08:00:00.000Z' },
        { ...OTHER, for: 'ws-1/brief/slack', at: '2026-11-16T08:01:00.000Z' },
      ],
    });
    // Another start reads what this one left.
    expect(new ServerGroupLedger(file).all()).toEqual([GROUP, OTHER]);
    ledger.remove(GROUP);
    expect(ledger.all()).toEqual([OTHER]);
    // The same pgid with another start time is another process.
    ledger.remove({ ...OTHER, startedAt: '' });
    expect(ledger.all()).toEqual([OTHER]);
  });

  it('reads none from a file that does not read, and says so', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ledger = new ServerGroupLedger({
      read: () => {
        throw new Error('damaged');
      },
      write: () => {},
    });
    expect(ledger.all()).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it('does nothing with no file', () => {
    const ledger = new ServerGroupLedger(undefined);
    ledger.add(GROUP, 'x', 'y');
    ledger.remove(GROUP);
    expect(ledger.all()).toEqual([]);
  });

  it('lets a write that fails throw, so the start it records fails', () => {
    const ledger = new ServerGroupLedger({
      read: () => null,
      write: () => {
        throw new Error('disk full');
      },
    });
    expect(() => ledger.add(GROUP, 'x', 'y')).toThrow('disk full');
  });
});
