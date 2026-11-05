import { describe, expect, it } from 'vitest';
import { parseToolRef } from './runTarget';

describe('parseToolRef', () => {
    it('parses built-in and plugin tool references', () => {
        expect(parseToolRef('consola#cleanup_stale_sessions')).toEqual({
            ref: 'consola#cleanup_stale_sessions',
            namespace: 'consola',
            tool: 'cleanup_stale_sessions',
        });
        expect(parseToolRef('plugin:review-sla#oldest_waiting')).toMatchObject({
            namespace: 'plugin:review-sla',
            tool: 'oldest_waiting',
        });
    });

    it('rejects empty and malformed references, and bare names', () => {
        expect(parseToolRef('')).toBeNull();
        expect(parseToolRef('consola#')).toBeNull();
        expect(parseToolRef('#tool')).toBeNull();
        expect(parseToolRef('Consola#tool')).toBeNull();
        expect(parseToolRef('Review')).toBeNull();
    });
});
