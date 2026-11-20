/**
 * ⌘Q has to be held, or pressed twice, before Consola quits.
 *
 * Quitting stops every session's PTY, so a stray ⌘Q (aimed at ⌘W, or at
 * another app) should cost nothing. The handler sits on `before-input-event`,
 * which runs before the menu: preventing the event there keeps the Quit
 * item's accelerator from firing, while clicking Quit in the menu still quits
 * at once.
 *
 * Two macOS facts shape it. A letter's keyUp is not delivered while ⌘ is
 * down, so "still held" is proven by the key's auto-repeat keydowns, not by
 * the absence of a release. And once the hold has succeeded, quitting waits
 * for the key to be let go (or to fall quiet): quitting under a still-held ⌘Q
 * would hand its remaining repeats to whichever app comes forward, and quit
 * that one too. The window is hidden meanwhile, so the quit still feels
 * immediate.
 */

export const QUIT_HOLD_MS = 1200;
export const QUIT_DOUBLE_PRESS_MS = 500;
/** How long after the last repeat a held ⌘Q counts as let go. */
const RELEASE_GRACE_MS = 600;
/** A slow key-repeat rate can outlast the grace; wait two of its beats instead. */
const REPEAT_CADENCE_MULTIPLIER = 2;

/** The fields of Electron's `Input` this reads. */
export interface QuitKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

export interface QuitShortcutOptions {
  /** Show (`down`) or let go of (`up`) the "Hold ⌘Q" hint in this window. */
  readonly notify: (state: 'down' | 'up') => void;
  /** Hide the window while a successful hold waits for the key to be let go. */
  readonly conceal: () => void;
  readonly quit: () => void;
}

export function createQuitShortcut(
  options: QuitShortcutOptions,
): (event: { preventDefault: () => void }, input: QuitKeyInput) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A ⌘Q press is down and could still become a hold. */
  let holding = false;
  /** The hold succeeded: quit as soon as the key is let go. */
  let quitting = false;
  /** The window is showing the hint. */
  let hinted = false;
  let heldSince = 0;
  let lastPressAt = 0;
  let lastRepeatAt = 0;
  let repeatCadenceMs = 0;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const clearPress = () => {
    clearTimer();
    holding = false;
    quitting = false;
    lastRepeatAt = 0;
    repeatCadenceMs = 0;
  };

  /** The press is over. `lastPressAt` survives, so a second press can still quit. */
  const release = () => {
    clearPress();
    if (hinted) {
      hinted = false;
      options.notify('up');
    }
  };

  const quitNow = () => {
    release();
    lastPressAt = 0;
    options.quit();
  };

  const quitWhenQuiet = () => {
    clearTimer();
    const quietMs = Math.max(RELEASE_GRACE_MS, repeatCadenceMs * REPEAT_CADENCE_MULTIPLIER);
    timer = setTimeout(quitNow, quietMs);
  };

  return (event, input) => {
    const key = input.key.toLowerCase();

    if (input.type === 'keyUp') {
      if (key === 'q') {
        if (quitting) quitNow();
        else release();
      } else if (key === 'meta') {
        // Q's own keyUp may never come while ⌘ was down; this is the release.
        if (quitting) quitWhenQuiet();
        else release();
      }
      return;
    }
    if (input.type !== 'keyDown') return;

    const isQuitChord = input.meta && !input.control && !input.alt && !input.shift && key === 'q';
    const now = Date.now();

    if (input.isAutoRepeat && isQuitChord) {
      repeatCadenceMs = now - (lastRepeatAt === 0 ? heldSince : lastRepeatAt);
      lastRepeatAt = now;
    }

    // The window is already hidden; nothing typed now belongs to it.
    if (quitting) {
      event.preventDefault();
      if (key === 'q') quitWhenQuiet();
      return;
    }

    if (!isQuitChord) {
      // Pressing ⌘ itself neither starts nor cancels anything.
      if (key === 'meta') return;
      // Any other key ends the press. This is also where a keyUp macOS never
      // delivered gets caught up with.
      if (!input.isAutoRepeat) {
        lastPressAt = 0;
        release();
      }
      return;
    }

    event.preventDefault();

    if (input.isAutoRepeat) {
      if (holding && now - heldSince >= QUIT_HOLD_MS) {
        holding = false;
        quitting = true;
        options.conceal();
        quitWhenQuiet();
      }
      return;
    }

    const previousPressAt = lastPressAt;
    lastPressAt = now;
    if (previousPressAt !== 0 && now - previousPressAt <= QUIT_DOUBLE_PRESS_MS) {
      quitNow();
      return;
    }

    clearPress();
    holding = true;
    heldSince = now;
    if (!hinted) {
      hinted = true;
      options.notify('down');
    }
    // With key repeat turned off, or Q tapped once under a held ⌘, nothing
    // else may ever arrive: let the hint go on its own.
    timer = setTimeout(release, QUIT_HOLD_MS + RELEASE_GRACE_MS);
  };
}
