import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { TERMINAL_SCROLLBACK_LINES } from '../shared/constants';
import type { ScreenReplay } from '../shared/types';

/**
 * A headless terminal mirroring what a PTY is displaying.
 *
 * The main process needs to answer two questions about a running TUI: what is
 * currently on screen, and how does a reattaching view repaint it. Neither can
 * be answered from the raw byte stream — Claude positions text with cursor
 * moves and overwrites in place, so recent bytes are not the current screen.
 * Feeding the stream through a real emulator gives exact answers to both.
 */

export class ScreenModel {
  private readonly terminal: HeadlessTerminal;
  private readonly serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.terminal = new HeadlessTerminal({
      cols,
      rows,
      // As much as the pane keeps: a remounted pane has only this to show.
      scrollback: TERMINAL_SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
  }

  /**
   * Parse `data` now, not on a later tick.
   *
   * A view that mounts repaints from `snapshot()`, and main stops sending a
   * terminal's output while no view is mounted, so a byte the snapshot
   * missed would never reach the screen at all. xterm's own `write` parses
   * on a timer; its core's `writeSync` (what Orca's headless emulator uses)
   * parses in the same turn, at about 0.2 ms per 10 KB. `callback` still runs
   * asynchronously, as xterm's would.
   */
  public write(data: string, callback?: () => void): void {
    const core = (this.terminal as unknown as { _core?: { writeSync?(data: string): void } })._core;
    if (typeof core?.writeSync !== 'function') {
      this.terminal.write(data, callback);
      return;
    }
    core.writeSync(data);
    if (callback) queueMicrotask(callback);
  }

  public resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /**
   * Escape sequences that reconstruct the current screen, and its size.
   *
   * Written into a fresh xterm view of that size, this restores what the
   * PTY is showing — including alternate-screen TUIs — without replaying
   * the whole session. Into a view of any other size it does not.
   */
  public snapshot(): ScreenReplay {
    const replay = this.serializer.serialize();
    return {
      // The serializer leaves out DEC 2026. Caught mid-frame, the view would
      // paint the half-drawn frame; reopened, it holds until the live end
      // marker arrives (xterm lets go after a second regardless).
      replay: this.terminal.modes.synchronizedOutputMode ? `\x1b[?2026h${replay}` : replay,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  /** The text currently visible in the viewport, one line per row. */
  public visibleText(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let row = 0; row < this.terminal.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }

    return lines.join('\n');
  }

  /**
   * The visible text with faint (SGR 2) cells blanked out.
   *
   * Claude fills an empty composer with a faint example prompt, so the
   * plain text of an idle composer is not empty. Faint is how a TUI says
   * "not really there"; what the user actually typed is never drawn faint.
   */
  public visibleTextWithoutFaint(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let row = 0; row < this.terminal.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      if (!line) continue;
      let text = '';
      for (let col = 0; col < line.length; col++) {
        const cell = line.getCell(col);
        // Width 0 is the trailing half of a wide glyph, already emitted.
        if (!cell || cell.getWidth() === 0) continue;
        text += cell.isDim() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' ';
      }
      lines.push(text.trimEnd());
    }

    return lines.join('\n');
  }

  public dispose(): void {
    this.terminal.dispose();
  }
}
