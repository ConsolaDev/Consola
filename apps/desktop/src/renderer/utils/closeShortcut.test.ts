import { describe, expect, it } from 'vitest';
import { closeTarget } from './closeShortcut';

describe('closeTarget', () => {
  it('closes the Inbox or Automations before anything under it', () => {
    expect(
      closeTarget({ overlay: 'inbox', activeSessionId: 's1', activePreviewTabId: '/a.ts' }),
    ).toBe('overlay');
    expect(
      closeTarget({ overlay: 'automations', activeSessionId: null, activePreviewTabId: null }),
    ).toBe('overlay');
  });

  it('closes the active preview tab beside a session', () => {
    expect(closeTarget({ overlay: null, activeSessionId: 's1', activePreviewTabId: '/a.ts' })).toBe(
      'preview-tab',
    );
  });

  it('leaves tabs alone when no session pane is showing them', () => {
    expect(
      closeTarget({ overlay: null, activeSessionId: null, activePreviewTabId: '/a.ts' }),
    ).toBeNull();
  });

  it('closes nothing, and never the session, when nothing else is open', () => {
    expect(
      closeTarget({ overlay: null, activeSessionId: 's1', activePreviewTabId: null }),
    ).toBeNull();
  });
});
