import { create } from 'zustand';
import type { OpenInResult, OpenInTarget } from '../../shared/openIn';
import { favouriteTarget } from '../openIn/favourite';
import { openInBridge } from '../services/openInBridge';
import { useSettingsStore } from './settingsStore';
import { showToast } from './toastStore';

interface OpenInState {
  /** The apps main last listed, the file manager last; null until its first answer. */
  targets: OpenInTarget[] | null;
}

/**
 * "Open in" as the renderer knows it: what main listed. Main keeps the list
 * for the run and looks again behind each answer, so asking each time the
 * menu opens is how the menu stays current. The favourite is the settings'
 * (`openInFavourite`).
 */
export const useOpenInStore = create<OpenInState>(() => ({ targets: null }));

let asking: Promise<OpenInTarget[]> | null = null;

/**
 * Asks main for the apps, once at a time; its answer replaces the list. One
 * that fails keeps the list there was, or leaves an empty one, so the menu
 * still opens, and asks again.
 */
export function loadOpenInTargets(): Promise<OpenInTarget[]> {
  asking ??= openInBridge
    .list()
    .then(
      (targets) => {
        useOpenInStore.setState({ targets });
        return targets;
      },
      (error: unknown) => {
        console.warn('Open in: listing the apps failed:', error);
        const kept = useOpenInStore.getState().targets ?? [];
        useOpenInStore.setState({ targets: kept });
        return kept;
      },
    )
    .finally(() => {
      asking = null;
    });
  return asking;
}

/** The app the button and ⌘O open in, from what is listed now. */
export function useOpenInFavourite(): OpenInTarget | undefined {
  const targets = useOpenInStore((state) => state.targets);
  const favouriteId = useSettingsStore((state) => state.openInFavourite);
  return targets ? favouriteTarget(targets, favouriteId) : undefined;
}

/** Opens `folder` in `target`; why it did not, when it did not, is said in a toast. */
export async function openFolderIn(target: OpenInTarget, folder: string): Promise<void> {
  const result: OpenInResult = await openInBridge
    .open({ targetId: target.id, path: folder })
    .catch((error: unknown) => ({
      ok: false,
      error: `Couldn't open the folder: ${error instanceof Error ? error.message : String(error)}`,
    }));
  if (!result.ok) showToast(result.error);
}

/** The person chose `target`, from the menu or the palette: it opens there, and becomes the favourite. */
export function pickOpenIn(target: OpenInTarget, folder: string): Promise<void> {
  useSettingsStore.getState().setOpenInFavourite(target.id);
  return openFolderIn(target, folder);
}

/** Opens `folder` in the favourite, asking main for the list first when there is none yet. */
export async function openFolderInFavourite(folder: string): Promise<void> {
  const targets = useOpenInStore.getState().targets ?? (await loadOpenInTargets());
  const target = favouriteTarget(targets, useSettingsStore.getState().openInFavourite);
  if (target) await openFolderIn(target, folder);
}
