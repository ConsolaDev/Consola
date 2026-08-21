import { describe, expect, it } from 'vitest';
import { deriveTerminalStatus } from './terminalStatus';

describe('deriveTerminalStatus', () => {
    it.each([
        // A dead process wants nothing: exited wins over everything.
        [{ busy: false, awaitingConfirmation: false, exited: true }, 'exited'],
        [{ busy: true, awaitingConfirmation: true, exited: true }, 'exited'],
        // A menu on screen outranks output still trickling in.
        [{ busy: true, awaitingConfirmation: true, exited: false }, 'needs-attention'],
        [{ busy: false, awaitingConfirmation: true, exited: false }, 'needs-attention'],
        [{ busy: true, awaitingConfirmation: false, exited: false }, 'working'],
        [{ busy: false, awaitingConfirmation: false, exited: false }, 'ready'],
    ] as const)('derives %j as %s', (flags, expected) => {
        expect(deriveTerminalStatus(flags)).toBe(expected);
    });
});
