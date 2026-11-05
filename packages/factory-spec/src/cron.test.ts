import { describe, expect, it } from 'vitest';
import { cronError, nextCronOccurrence } from './cron';

describe('cronError', () => {
    it('accepts classic five-field expressions', () => {
        expect(cronError('0 9 * * *')).toBeNull();
        expect(cronError('*/15 8-18 * * 1-5')).toBeNull();
    });

    it('refuses the wrong number of fields', () => {
        expect(cronError('0 9 * *')).toMatch(/got 4/);
        expect(cronError('0 0 9 * * *')).toMatch(/got 6/);
        expect(cronError('@daily')).toMatch(/got 1/);
    });

    it('refuses out-of-range values', () => {
        expect(cronError('61 9 * * *')).toMatch(/Invalid cron expression/);
    });
});

describe('nextCronOccurrence', () => {
    it('returns the first occurrence strictly after the given time, in local time', () => {
        const after = new Date(2026, 10, 4, 8, 30);
        expect(nextCronOccurrence('0 9 * * *', after)).toEqual(new Date(2026, 10, 4, 9, 0));
    });

    it('is strictly after: an occurrence exactly at `after` is not returned', () => {
        const at = new Date(2026, 10, 4, 9, 0);
        expect(nextCronOccurrence('0 9 * * *', at)).toEqual(new Date(2026, 10, 5, 9, 0));
    });

    it('honours day-of-week', () => {
        // 2026-11-07 is a Saturday; the next weekday 09:00 is Monday the 9th.
        const saturday = new Date(2026, 10, 7, 10, 0);
        expect(nextCronOccurrence('0 9 * * 1-5', saturday)).toEqual(new Date(2026, 10, 9, 9, 0));
    });
});
