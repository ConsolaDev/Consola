const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

/**
 * A five-field cron in words, for the panel: "Weekdays at 9:00". The common
 * shapes only; anything else reads as the expression itself, which the panel
 * shows beside it anyway.
 */
export function describeSchedule(cron: string): string {
    const fields = cron.trim().split(/\s+/);
    if (fields.length !== 5) return `Cron ${cron}`;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    const every = /^\*\/(\d+)$/.exec(minute);
    if (every && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
        return Number(every[1]) === 1 ? 'Every minute' : `Every ${Number(every[1])} minutes`;
    }
    if (dayOfMonth !== '*' || month !== '*' || !/^\d{1,2}$/.test(minute)) return `Cron ${cron}`;
    const mm = minute.padStart(2, '0');
    if (hour === '*' && dayOfWeek === '*') return mm === '00' ? 'Every hour' : `Every hour at :${mm}`;
    if (!/^\d{1,2}$/.test(hour)) return `Cron ${cron}`;
    const at = `at ${Number(hour)}:${mm}`;
    if (dayOfWeek === '*') return `Every day ${at}`;
    if (dayOfWeek === '1-5') return `Weekdays ${at}`;
    if (dayOfWeek === '0,6' || dayOfWeek === '6,0' || dayOfWeek === '6,7') return `Weekends ${at}`;
    if (/^[0-7]$/.test(dayOfWeek)) return `${DAYS[Number(dayOfWeek)]} ${at}`;
    return `Cron ${cron}`;
}
