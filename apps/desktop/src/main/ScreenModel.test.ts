import { describe, expect, it } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { TERMINAL_SCROLLBACK_LINES } from '../shared/constants';
import { ScreenModel } from './ScreenModel';

const COLS = 80;
const ROWS = 24;

/** A terminal configured like a session pane in the renderer. */
function pane(): HeadlessTerminal {
    return new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: TERMINAL_SCROLLBACK_LINES, allowProposedApi: true });
}

function write(terminal: { write(data: string, callback?: () => void): void }, data: string): Promise<void> {
    return new Promise((resolve) => terminal.write(data, resolve));
}

function oldestLine(terminal: HeadlessTerminal): string {
    return terminal.buffer.active.getLine(0)?.translateToString(true) ?? '';
}

function lines(count: number): string {
    let data = '';
    for (let i = 0; i < count; i++) data += `line ${i}\r\n`;
    return data;
}

describe('ScreenModel', () => {
    it('repaints a pane with as much history as the live pane kept', async () => {
        // More output than either side holds, so both have dropped their
        // oldest lines and the question is only where each one stopped.
        const output = lines(TERMINAL_SCROLLBACK_LINES + ROWS + 500);
        const live = pane();
        const model = new ScreenModel(COLS, ROWS);
        await write(live, output);
        await write(model, output);

        const remounted = pane();
        await write(remounted, model.snapshot());

        expect(oldestLine(remounted)).toBe(oldestLine(live));
        live.dispose();
        model.dispose();
        remounted.dispose();
    });

    it('keeps a long conversation whole across a remount', async () => {
        // About what one long working day in a session prints.
        const model = new ScreenModel(COLS, ROWS);
        await write(model, lines(6000));

        const remounted = pane();
        await write(remounted, model.snapshot());

        expect(oldestLine(remounted)).toBe('line 0');
        model.dispose();
        remounted.dispose();
    });
});
