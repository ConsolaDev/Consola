import { describe, expect, it, vi } from 'vitest';

// The registry names row components and actions; neither is under test, and
// both drag in the whole renderer (window bridges and all).
vi.mock('../components/Sidebar/rows/SessionRow', () => ({ SessionRow: () => null }));
vi.mock('../utils/sessionActions', () => ({ activateSession: vi.fn() }));
vi.mock('./entries', () => ({ idOfKey: (key: string) => key.slice(key.indexOf(':') + 1) }));

import { entry } from './entryFixtures';
import { ROW_KINDS, entryRow } from './rowRegistry';

describe('rowRegistry', () => {
  it('registers sessions, and only sessions, in this slice', () => {
    expect(Object.keys(ROW_KINDS)).toEqual(['session']);
  });

  it('draws a registered kind', () => {
    expect(entryRow(entry('a', 'ready'), { workspaceId: 'w', active: false })).not.toBeNull();
  });

  it('draws nothing for a kind nobody registered rather than guessing a row', () => {
    expect(entryRow(entry('a', 'ready', { kind: 'run' }), { workspaceId: 'w', active: false })).toBeNull();
  });
});
