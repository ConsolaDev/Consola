import type { ScreenReplay } from '../../../shared/types';

/** What this needs of a terminal: @xterm/xterm's and @xterm/headless's alike. */
interface RestorableTerminal {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

/**
 * Lay a screen main kept into a freshly mounted view.
 *
 * The view is first made the size the screen was captured at, whatever its
 * pane measures. A replay only reproduces the screen at that size; written
 * at any other, xterm lays it out there, and when the pane then settles at
 * the PTY's own size the PTY is not resized, so the CLI never repaints what
 * that rearranged. A shrink is the case that bites: xterm drops the rows
 * below the cursor, which is where Claude keeps the frame around its prompt,
 * and the CLI's relative cursor moves then put typing rows above the prompt.
 *
 * `restored` runs once the replay is in. Fit the view to its pane only then:
 * if the pane differs from the captured size, that is a real resize of the
 * PTY, and the CLI repaints for it.
 *
 * The replay goes in REPLAY_CHUNK slices. xterm yields to the page between
 * writes but never inside one, and a long conversation's replay runs to
 * megabytes: written whole, a tab switch would freeze typing and painting
 * until all of it was parsed. xterm carries its parser state, and a split
 * surrogate pair, from one write to the next, so any cut is safe.
 */
export function restoreScreen(
  terminal: RestorableTerminal,
  screen: ScreenReplay,
  restored: () => void,
): void {
  if (terminal.cols !== screen.cols || terminal.rows !== screen.rows) {
    terminal.resize(screen.cols, screen.rows);
  }
  const { replay } = screen;
  if (replay.length <= REPLAY_CHUNK) {
    terminal.write(replay, restored);
    return;
  }
  for (let start = 0; start < replay.length; start += REPLAY_CHUNK) {
    const end = start + REPLAY_CHUNK;
    terminal.write(replay.slice(start, end), end >= replay.length ? restored : undefined);
  }
}

/** The most of a replay written at once; see restoreScreen. */
export const REPLAY_CHUNK = 16 * 1024;

/** How long a pane's size must hold before its view and the PTY follow it. */
export const PANE_SETTLE_MS = 100;

/**
 * Run `fit` once requests stop arriving for PANE_SETTLE_MS.
 *
 * A pane's layout can wobble on its way to a size — a panel measuring itself
 * after mount, a window coming back from sleep. Followed frame by frame, a
 * dip and return puts the PTY through two resizes, and a CLI that reads its
 * size once for both sees no change and does not repaint, while the view has
 * already lost the rows below its cursor to the dip. Waiting for the size to
 * settle means a wobble never reaches the view or the PTY at all.
 */
export function whenSettled(fit: () => void): { request(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    request() {
      clearTimeout(timer);
      timer = setTimeout(fit, PANE_SETTLE_MS);
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}
