import { afterEach, describe, expect, it, vi } from 'vitest';

/** `isMac` is fixed at module load, so each platform gets a fresh import. */
async function platformModule(platform: string) {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform });
  return import('./platform');
}

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: 'j', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init } as KeyboardEvent;
}

afterEach(() => vi.unstubAllGlobals());

describe('isAssistantShortcut', () => {
  it('matches Cmd+J on macOS and nothing wider', async () => {
    const { isAssistantShortcut } = await platformModule('MacIntel');
    expect(isAssistantShortcut(key({ metaKey: true }))).toBe(true);
    expect(isAssistantShortcut(key({ metaKey: true, key: 'J' }))).toBe(true);
    expect(isAssistantShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isAssistantShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
    expect(isAssistantShortcut(key({ metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isAssistantShortcut(key({ ctrlKey: true }))).toBe(false);
  });

  it('matches Ctrl+Shift+J elsewhere, never a bare Ctrl+J', async () => {
    const { isAssistantShortcut } = await platformModule('Linux x86_64');
    expect(isAssistantShortcut(key({ ctrlKey: true, shiftKey: true, key: 'J' }))).toBe(true);
    expect(isAssistantShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isAssistantShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isAssistantShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
  });
});
