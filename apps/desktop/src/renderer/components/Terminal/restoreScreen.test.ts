import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { ScreenModel } from '../../../main/ScreenModel';
import { PANE_SETTLE_MS, restoreScreen, whenSettled } from './restoreScreen';

const COLS = 80;
const ROWS = 24;

function write(terminal: { write(data: string, callback?: () => void): void }, data: string): Promise<void> {
    return new Promise((resolve) => terminal.write(data, resolve));
}

/**
 * The bottom of Claude's inline (non-fullscreen) screen, as the CLI paints it:
 * the prompt's frame, then the cursor parked back up at the caret. The frame
 * keeps four rows below the caret — the rule, two status lines, and the row
 * the last newline opened.
 */
const PROMPT =
    '─'.repeat(COLS) + '\r\n' +
    '❯ \r\n' +
    '─'.repeat(COLS) + '\r\n' +
    '  ⏵⏵ auto mode on\r\n' +
    '  ◐ medium · /effort\r\n' +
    '\x1b[2C\x1b[4A';

/**
 * Typing one character, byte for byte the way the CLI draws it: down to the
 * frame's last row, back up to the caret, the glyph, then back down and up
 * again to park. Every move is relative to where the cursor is.
 */
function keystroke(char: string, column: number): string {
    return `\x1b[${column}D\x1b[4B\r\x1b[${column}C\x1b[4A${char}\r\r\n\r\n\r\n\r\n\x1b[${column + 1}C\x1b[4A`;
}

async function type(terminal: HeadlessTerminal, text: string): Promise<void> {
    for (let i = 0; i < text.length; i++) await write(terminal, keystroke(text[i], 2 + i));
}

function row(terminal: HeadlessTerminal, y: number): string {
    const buffer = terminal.buffer.active;
    return buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '';
}

/** A session that has printed some history and is waiting at its prompt. */
async function idleSession(): Promise<ScreenModel> {
    const model = new ScreenModel(COLS, ROWS);
    let history = '';
    for (let i = 0; i < 200; i++) history += `line ${i}\r\n`;
    await write(model, history + PROMPT);
    return model;
}

/** Mount a view at `cols`×`rows`, restore into it, then let it settle at the PTY's own size. */
async function remount(model: ScreenModel, cols: number, rows: number): Promise<HeadlessTerminal> {
    const view = new HeadlessTerminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    await new Promise<void>((resolve) => restoreScreen(view, model.snapshot(), resolve));
    // The pane's final size is the PTY's, so the PTY is not resized and the
    // CLI never repaints: whatever the view holds now is what it keeps.
    view.resize(COLS, ROWS);
    return view;
}

describe('restoreScreen', () => {
    it('keeps typing on the prompt when the pane is first laid out taller than the PTY', async () => {
        const model = await idleSession();
        const view = await remount(model, COLS, ROWS + 6);

        await type(view, 'first');

        expect(row(view, ROWS - 5)).toBe('❯ first');
        model.dispose();
        view.dispose();
    });

    it('keeps typing on the prompt when the pane is first laid out narrower than the PTY', async () => {
        const model = await idleSession();
        const view = await remount(model, COLS - 10, ROWS);

        await type(view, 'first');

        expect(row(view, ROWS - 5)).toBe('❯ first');
        model.dispose();
        view.dispose();
    });

    it('calls back only once the screen is in the view', async () => {
        const model = await idleSession();
        const view = new HeadlessTerminal({ cols: COLS, rows: ROWS + 6, scrollback: 1000, allowProposedApi: true });

        const prompt = await new Promise<string>((resolve) =>
            restoreScreen(view, model.snapshot(), () => {
                const buffer = view.buffer.active;
                resolve(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString().trimEnd() ?? '');
            })
        );

        expect(prompt).toBe('❯');
        model.dispose();
        view.dispose();
    });
});

describe('whenSettled', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('follows a pane only once it has held still', () => {
        vi.useFakeTimers();
        const fit = vi.fn();
        const settled = whenSettled(fit);

        // A layout that wobbles for a few frames on its way to its size.
        settled.request();
        vi.advanceTimersByTime(16);
        settled.request();
        vi.advanceTimersByTime(16);
        settled.request();
        vi.advanceTimersByTime(PANE_SETTLE_MS - 1);
        expect(fit).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(fit).toHaveBeenCalledTimes(1);
    });

    it('never fits a view that has gone', () => {
        vi.useFakeTimers();
        const fit = vi.fn();
        const settled = whenSettled(fit);

        settled.request();
        settled.cancel();
        vi.advanceTimersByTime(PANE_SETTLE_MS * 2);

        expect(fit).not.toHaveBeenCalled();
    });
});
