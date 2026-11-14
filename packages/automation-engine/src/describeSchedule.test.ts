import { describe, expect, it } from 'vitest';
import { describeSchedule } from './describeSchedule';

describe('describeSchedule', () => {
    it.each([
        ['0 9 * * 1-5', 'Weekdays at 9:00'],
        ['30 8 * * *', 'Every day at 8:30'],
        ['0 10 * * 0,6', 'Weekends at 10:00'],
        ['15 9 * * 1', 'Mondays at 9:15'],
        ['*/5 * * * *', 'Every 5 minutes'],
        ['0 * * * *', 'Every hour'],
        ['0 9 1 * *', 'Cron 0 9 1 * *'],
        ['0 9-17 * * *', 'Cron 0 9-17 * * *'],
    ])('%s reads as %s', (cron, words) => {
        expect(describeSchedule(cron)).toBe(words);
    });
});
