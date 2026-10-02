import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

/**
 * A headless terminal mirroring what a PTY is displaying.
 *
 * The main process needs to answer two questions about a running TUI: what is
 * currently on screen, and how does a reattaching view repaint it. Neither can
 * be answered from the raw byte stream — Claude positions text with cursor
 * moves and overwrites in place, so recent bytes are not the current screen.
 * Feeding the stream through a real emulator gives exact answers to both.
 */

/** Enough history for the pane's scrollback without holding a session's worth. */
const SCROLLBACK_LINES = 2000;

export class ScreenModel {
    private readonly terminal: HeadlessTerminal;
    private readonly serializer: SerializeAddon;

    constructor(cols: number, rows: number) {
        this.terminal = new HeadlessTerminal({
            cols,
            rows,
            scrollback: SCROLLBACK_LINES,
            allowProposedApi: true,
        });
        this.serializer = new SerializeAddon();
        this.terminal.loadAddon(this.serializer);
    }

    public write(data: string, callback?: () => void): void {
        this.terminal.write(data, callback);
    }

    public resize(cols: number, rows: number): void {
        this.terminal.resize(cols, rows);
    }

    /**
     * Escape sequences that reconstruct the current screen.
     *
     * Written into a fresh xterm view, this restores what the PTY is showing —
     * including alternate-screen TUIs — without replaying the whole session.
     */
    public snapshot(): string {
        return this.serializer.serialize();
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
