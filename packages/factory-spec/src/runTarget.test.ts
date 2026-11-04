import { describe, expect, it } from 'vitest';
import { parseRunTarget } from './runTarget';

describe('parseRunTarget', () => {
    it('parses built-in and plugin tool references', () => {
        expect(parseRunTarget('consola#cleanup_stale_sessions')).toEqual({
            kind: 'tool',
            ref: 'consola#cleanup_stale_sessions',
            namespace: 'consola',
            tool: 'cleanup_stale_sessions',
        });
        expect(parseRunTarget('plugin:review-sla#oldest_waiting')).toMatchObject({
            kind: 'tool',
            namespace: 'plugin:review-sla',
            tool: 'oldest_waiting',
        });
    });

    it('treats a bare name as an action', () => {
        expect(parseRunTarget(' Fix CI ')).toEqual({ kind: 'action', ref: 'Fix CI', name: 'Fix CI' });
    });

    it('rejects empty and malformed references', () => {
        expect(parseRunTarget('')).toBeNull();
        expect(parseRunTarget('consola#')).toBeNull();
        expect(parseRunTarget('#tool')).toBeNull();
        expect(parseRunTarget('Consola#tool')).toBeNull();
    });
});
