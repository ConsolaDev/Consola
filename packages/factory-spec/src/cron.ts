import { Cron } from 'croner';

/**
 * Classic five-field cron (`minute hour day-of-month month day-of-week`),
 * evaluated in the runner's local time zone.
 *
 * Croner also accepts a seconds field and nicknames; both are refused so a
 * spec stays portable to whichever scheduler the cloud runner ends up using.
 */
export function cronError(expression: string): string | null {
    const fields = expression.trim().split(/\s+/).filter(Boolean);
    if (fields.length !== 5) {
        return (
            'Expected five cron fields (minute hour day-of-month month day-of-week), ' +
            `got ${fields.length}: "${expression}".`
        );
    }
    try {
        new Cron(expression.trim(), { paused: true }).stop();
        return null;
    } catch (error) {
        return `Invalid cron expression "${expression}": ${
            error instanceof Error ? error.message : String(error)
        }`;
    }
}

/** The first occurrence strictly after `after`, or null if the pattern never fires again. */
export function nextCronOccurrence(expression: string, after: Date): Date | null {
    const job = new Cron(expression.trim(), { paused: true });
    try {
        return job.nextRun(after);
    } finally {
        job.stop();
    }
}
