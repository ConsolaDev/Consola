import { create } from 'zustand';
import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/preferences';
import { preferencesBridge } from '../services/preferencesBridge';

/**
 * What main holds that main has to read itself. Main is the source of truth
 * (the sweeper runs there), so this only mirrors it: a write goes to main and
 * comes back on the change push, to every window.
 */
export const usePreferencesStore = create<Preferences>(() => ({ ...DEFAULT_PREFERENCES }));

export async function hydratePreferences(): Promise<void> {
  usePreferencesStore.setState(await preferencesBridge.get());
}

/** Apply main's pushed changes. Returns the unsubscribe. */
export function subscribeToPreferences(): () => void {
  return preferencesBridge.onChanged((preferences) => usePreferencesStore.setState(preferences));
}
