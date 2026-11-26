import { describe, expect, it } from 'vitest';
import { chooseSection, sectionIdOfHash } from './sections';
import { hashOfSettingsPage, SETTINGS_SECTION_ID, settingsPageIdOfHash } from './settings';

describe('a settings page in the address', () => {
  it('is the id after #/settings/', () => {
    expect(settingsPageIdOfHash('#/settings/connections')).toBe('connections');
    expect(settingsPageIdOfHash('#/settings/connections?x=1')).toBe('connections');
    expect(settingsPageIdOfHash('#/settings/connections/github')).toBe('connections');
    expect(settingsPageIdOfHash('#/settings/two-words')).toBe('two-words');
  });

  it('is none for Settings alone, another section, or what is not an id', () => {
    for (const hash of ['', '#', '#/settings', '#/settings/', '#/connections', '#/overview/x']) {
      expect(settingsPageIdOfHash(hash)).toBeNull();
    }
    for (const hash of ['#/settings/Connections', '#/settings/-x', '#/settings/a--b']) {
      expect(settingsPageIdOfHash(hash)).toBeNull();
    }
  });

  it('opens the Settings section, whichever page it names', () => {
    const hash = hashOfSettingsPage('connections');
    expect(hash).toBe('#/settings/connections');
    expect(sectionIdOfHash(hash)).toBe(SETTINGS_SECTION_ID);
    expect(settingsPageIdOfHash(hash)).toBe('connections');
  });

  it('opens the first page when it names none, or one this build does not have', () => {
    const pages: readonly [{ id: string }, ...Array<{ id: string }>] = [
      { id: 'connections' },
      { id: 'members' },
    ];
    expect(chooseSection(pages, settingsPageIdOfHash('#/settings'))).toBe(pages[0]);
    expect(chooseSection(pages, settingsPageIdOfHash('#/settings/billing'))).toBe(pages[0]);
    expect(chooseSection(pages, settingsPageIdOfHash('#/settings/members'))).toBe(pages[1]);
  });
});
