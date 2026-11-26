import type { BrowserWindow, WebContents } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { BrowserShortcutMessage } from '../../shared/browser';
import { forwardedShortcutFor, shortcutPlatformOf } from '../../shared/shortcuts';
import type { ForwardedShortcut } from '../../shared/shortcuts';

/** The parts of Electron's `Input` the decision reads. */
export interface GuestKeyInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
}

export interface ShortcutDecision {
  action: ForwardedShortcut;
  /** A held key repeats: the page must still not see it, but the window is told once. */
  send: boolean;
}

/**
 * What to do with a key pressed inside a page: nothing, or take it.
 *
 * Only a key-down is looked at, and only the chords the app owns
 * (`forwardedShortcutFor`). Everything else, typing included, stays with the
 * page untouched.
 */
export function decideGuestShortcut(
  input: GuestKeyInput,
  platform: string = process.platform,
): ShortcutDecision | null {
  if (input.type !== 'keyDown') return null;
  const action = forwardedShortcutFor(
    {
      key: input.key,
      code: input.code,
      meta: input.meta,
      ctrl: input.control,
      shift: input.shift,
      alt: input.alt,
      isComposing: input.isComposing,
    },
    shortcutPlatformOf(platform),
  );
  return action ? { action, send: !input.isAutoRepeat } : null;
}

/**
 * A focused `<webview>` keeps its keys: the window's listeners never hear
 * them, so a chord like ⌘K would do nothing while a page had focus. Main takes
 * the app's chords from the page and hands them to the window that hosts it.
 *
 * Nothing here focuses anything: the window learns the chord and acts on it,
 * the way it would had the key reached it directly.
 *
 * `tabIdOf` may answer null: a page's first keys can arrive before the window
 * has bound it to its tab, and the chord is still worth sending.
 */
export function forwardGuestShortcuts(
  guest: WebContents,
  host: BrowserWindow,
  tabIdOf: () => string | null,
): void {
  guest.on('before-input-event', (event, input) => {
    const decision = decideGuestShortcut(input);
    if (!decision) return;
    event.preventDefault();
    if (!decision.send || host.isDestroyed() || host.webContents.isDestroyed()) return;
    const message: BrowserShortcutMessage = { tabId: tabIdOf(), action: decision.action };
    host.webContents.send(IPC_CHANNELS.BROWSER_SHORTCUT, message);
  });
}
