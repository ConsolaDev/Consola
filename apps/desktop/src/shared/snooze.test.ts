// Pin the zone so the DST cases cross a real transition. Imports are hoisted
// above this line, which is fine: snooze.ts makes no Date while loading.
process.env.TZ = 'America/New_York';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SNOOZE_PRESETS,
  describeSnoozePreset,
  describeWake,
  formatClock,
  isSnoozePresetSetting,
  MAX_SNOOZE_PRESETS,
  normalizeSnoozePresets,
  pickSnoozePreset,
  resolveCustomSnooze,
  resolveSnoozePresets,
  SNOOZE_PRESET_MAX_MS,
  snoozePresetsEqual,
  snoozeWakeLabel,
} from './snooze';
import type { SnoozePresetSetting } from './snooze';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A local New York instant, with a 1-based month so the dates read as written. */
function at(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0) {
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
}

// November 2026: Mon 16, Tue 17, Wed 18, Thu 19, Fri 20, Sat 21, Sun 22, Mon 23.
const THURSDAY_10AM = at(2026, 11, 19, 10);

function menu(presets: ReadonlyArray<SnoozePresetSetting>, now: number) {
  return resolveSnoozePresets(presets, now, 'en-US');
}

function rows(presets: ReadonlyArray<SnoozePresetSetting>, now: number) {
  return menu(presets, now).map(({ label, timeLabel }) => `${label} · ${timeLabel}`);
}

describe('the test clock', () => {
  it('runs in New York, where 8 March 2026 skips 02:00–03:00', () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 2, 8, 2, 30).getHours()).toBe(3);
  });
});

describe('resolveSnoozePresets', () => {
  it('lists the defaults soonest first, naming the day only where the label does not', () => {
    expect(rows(DEFAULT_SNOOZE_PRESETS, THURSDAY_10AM)).toEqual([
      'In 1 hour · 11:00 AM',
      'In 3 hours · 1:00 PM',
      'This evening · 6:00 PM',
      'Tomorrow · 9:00 AM',
      'Next week · Mon 9:00 AM',
    ]);
    expect(menu(DEFAULT_SNOOZE_PRESETS, THURSDAY_10AM).map((row) => row.wakeAt)).toEqual([
      at(2026, 11, 19, 11),
      at(2026, 11, 19, 13),
      at(2026, 11, 19, 18),
      at(2026, 11, 20, 9),
      at(2026, 11, 23, 9),
    ]);
  });

  it('hides a "today" whose time has passed, including one passing right now', () => {
    const today: SnoozePresetSetting[] = [{ kind: 'at', day: 'today', time: '18:00' }];
    expect(menu(today, at(2026, 11, 19, 19))).toEqual([]);
    expect(menu(today, at(2026, 11, 19, 18))).toEqual([]);
    expect(menu(today, at(2026, 11, 19, 17, 59))).toHaveLength(1);
  });

  it('names the part of the day for a "today"', () => {
    const presets: SnoozePresetSetting[] = [
      { kind: 'at', day: 'today', time: '11:59' },
      { kind: 'at', day: 'today', time: '12:00' },
      { kind: 'at', day: 'today', time: '16:59' },
      { kind: 'at', day: 'today', time: '17:00' },
    ];
    expect(menu(presets, at(2026, 11, 19, 7)).map((row) => row.label)).toEqual([
      'This morning',
      'This afternoon',
      'This afternoon',
      'This evening',
    ]);
  });

  it('takes a weekday as the next one after today, never today itself', () => {
    const wednesday8am = at(2026, 11, 18, 8);
    const [row] = menu([{ kind: 'at', day: 'wednesday', time: '09:00' }], wednesday8am);
    expect(row.wakeAt).toBe(at(2026, 11, 25, 9));
    expect(`${row.label} · ${row.timeLabel}`).toBe('Next Wednesday · 9:00 AM');
    expect(rows([{ kind: 'at', day: 'friday', time: '09:00' }], wednesday8am)).toEqual([
      'Friday · 9:00 AM',
    ]);
  });

  it('reads a Monday option on a Sunday as Tomorrow', () => {
    const sunday = at(2026, 11, 22, 10);
    const [row] = menu([{ kind: 'at', day: 'monday', time: '09:00' }], sunday);
    expect(row.wakeAt).toBe(at(2026, 11, 23, 9));
    expect(`${row.label} · ${row.timeLabel}`).toBe('Tomorrow · 9:00 AM');
  });

  it('reads a Monday more than a day away as Next week, and shows its day', () => {
    const monday: SnoozePresetSetting[] = [{ kind: 'at', day: 'monday', time: '09:00' }];
    expect(rows(monday, at(2026, 11, 16, 10))).toEqual(['Next week · Mon 9:00 AM']);
    expect(rows(monday, at(2026, 11, 17, 10))).toEqual(['Next week · Mon 9:00 AM']);
    expect(menu(monday, at(2026, 11, 16, 10))[0].wakeAt).toBe(at(2026, 11, 23, 9));
  });

  it('shows the day a duration lands on when it is not today', () => {
    const thursdayLate = at(2026, 11, 19, 23, 30);
    expect(rows([{ kind: 'after', minutes: 60 }], thursdayLate)).toEqual([
      'In 1 hour · Fri 12:30 AM',
    ]);
    expect(rows([{ kind: 'after', minutes: 2 * 24 * 60 }], thursdayLate)).toEqual([
      'In 2 days · Sat 11:30 PM',
    ]);
  });

  it('words a duration in the largest unit that divides it evenly', () => {
    const labels = [1, 30, 60, 90, 180, 1440, 2880].map(
      (minutes) => menu([{ kind: 'after', minutes }], THURSDAY_10AM)[0].label,
    );
    expect(labels).toEqual([
      'In 1 minute',
      'In 30 minutes',
      'In 1 hour',
      'In 90 minutes',
      'In 3 hours',
      'In 1 day',
      'In 2 days',
    ]);
  });

  it('advances a set time by calendar date across DST', () => {
    const tomorrow2330: SnoozePresetSetting[] = [{ kind: 'at', day: 'tomorrow', time: '23:30' }];
    const beforeSpringForward = at(2026, 3, 7, 23, 30);
    const [spring] = menu(tomorrow2330, beforeSpringForward);
    expect(spring.wakeAt).toBe(at(2026, 3, 8, 23, 30));
    expect(spring.wakeAt - beforeSpringForward).toBe(23 * HOUR);

    const beforeFallBack = at(2026, 10, 31, 9);
    const [fall] = menu([{ kind: 'at', day: 'tomorrow', time: '09:00' }], beforeFallBack);
    expect(fall.wakeAt).toBe(at(2026, 11, 1, 9));
    expect(fall.wakeAt - beforeFallBack).toBe(25 * HOUR);
  });

  it('keeps a one-day duration to exactly 24 hours across DST', () => {
    const beforeSpringForward = at(2026, 3, 7, 23, 30);
    const [row] = menu([{ kind: 'after', minutes: 24 * 60 }], beforeSpringForward);
    expect(row.wakeAt - beforeSpringForward).toBe(24 * HOUR);
    expect(row.wakeAt).toBe(at(2026, 3, 9, 0, 30));
    expect(`${row.label} · ${row.timeLabel}`).toBe('In 1 day · Mon 12:30 AM');
  });

  it('keeps one row per wake minute, the first in Settings order', () => {
    // A duration keeps the clock's seconds; it still ties with 11:00 sharp.
    const now = at(2026, 11, 19, 10, 0, 30);
    const inAnHour: SnoozePresetSetting = { kind: 'after', minutes: 60 };
    const elevenToday: SnoozePresetSetting = { kind: 'at', day: 'today', time: '11:00' };

    const durationFirst = menu([inAnHour, elevenToday], now);
    expect(durationFirst.map(({ index, label }) => ({ index, label }))).toEqual([
      { index: 0, label: 'In 1 hour' },
    ]);
    const setTimeFirst = menu([elevenToday, inAnHour], now);
    expect(setTimeFirst.map(({ index, label }) => ({ index, label }))).toEqual([
      { index: 0, label: 'This morning' },
    ]);
  });

  it('collapses the defaults on a Sunday, when Tomorrow and Monday are the same wake', () => {
    const sunday = at(2026, 11, 22, 10);
    const result = menu(DEFAULT_SNOOZE_PRESETS, sunday);
    expect(result.map((row) => row.index)).toEqual([0, 1, 2, 3]);
    expect(rows(DEFAULT_SNOOZE_PRESETS, sunday)).toEqual([
      'In 1 hour · 11:00 AM',
      'In 3 hours · 1:00 PM',
      'This evening · 6:00 PM',
      'Tomorrow · 9:00 AM',
    ]);
  });

  it('orders by wake, whatever the Settings order', () => {
    const presets: SnoozePresetSetting[] = [
      { kind: 'at', day: 'monday', time: '09:00' },
      { kind: 'after', minutes: 180 },
      { kind: 'at', day: 'today', time: '18:00' },
      { kind: 'after', minutes: 60 },
    ];
    expect(menu(presets, THURSDAY_10AM).map((row) => row.index)).toEqual([3, 1, 2, 0]);
  });

  it('offers nothing for an empty list', () => {
    expect(menu([], THURSDAY_10AM)).toEqual([]);
  });
});

describe('pickSnoozePreset', () => {
  it('counts a duration from the pick, not from when the menu opened', () => {
    const [shown] = menu([{ kind: 'after', minutes: 60 }], THURSDAY_10AM);
    const pickedAt = THURSDAY_10AM + 5 * MINUTE;
    const picked = pickSnoozePreset(shown, pickedAt, 'en-US');
    expect(picked?.wakeAt).toBe(pickedAt + HOUR);
    expect(picked?.timeLabel).toBe('11:05 AM');
  });

  it('keeps the wake a set time showed, even after midnight passes', () => {
    const [shown] = menu(
      [{ kind: 'at', day: 'tomorrow', time: '09:00' }],
      at(2026, 11, 19, 23, 59),
    );
    expect(shown.wakeAt).toBe(at(2026, 11, 20, 9));
    expect(pickSnoozePreset(shown, at(2026, 11, 20, 0, 1), 'en-US')).toBe(shown);
  });

  it('gives null for a set time that has passed', () => {
    const [shown] = menu([{ kind: 'at', day: 'today', time: '18:00' }], at(2026, 11, 19, 17, 58));
    expect(pickSnoozePreset(shown, at(2026, 11, 19, 18), 'en-US')).toBeNull();
    expect(pickSnoozePreset(shown, at(2026, 11, 19, 18, 1), 'en-US')).toBeNull();
  });
});

describe('resolveCustomSnooze', () => {
  it('reads a date and time as local time', () => {
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2026-11-20', time: '09:00' }, THURSDAY_10AM),
    ).toEqual({ ok: true, until: at(2026, 11, 20, 9) });
  });

  it('rejects a time that has passed', () => {
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2026-11-19', time: '09:59' }, THURSDAY_10AM),
    ).toEqual({ ok: false, reason: 'past', message: 'That time has passed. Pick another.' });
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2026-11-19', time: '10:00' }, THURSDAY_10AM),
    ).toMatchObject({ ok: false, reason: 'past' });
  });

  it('rejects a date that does not exist rather than rolling it over', () => {
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2027-02-30', time: '09:00' }, THURSDAY_10AM),
    ).toEqual({ ok: false, reason: 'no-such-date', message: 'That date does not exist.' });
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2027-13-01', time: '09:00' }, THURSDAY_10AM),
    ).toMatchObject({ ok: false, reason: 'no-such-date' });
    expect(
      resolveCustomSnooze({ kind: 'at', date: '2028-02-29', time: '09:00' }, THURSDAY_10AM),
    ).toEqual({ ok: true, until: at(2028, 2, 29, 9) });
  });

  it('rejects a time the clocks skip', () => {
    const march1 = at(2026, 3, 1, 10);
    expect(resolveCustomSnooze({ kind: 'at', date: '2026-03-08', time: '02:30' }, march1)).toEqual({
      ok: false,
      reason: 'no-such-time',
      message: 'The clocks skip that time on that day. Pick another.',
    });
    expect(resolveCustomSnooze({ kind: 'at', date: '2026-03-08', time: '03:30' }, march1)).toEqual({
      ok: true,
      until: at(2026, 3, 8, 3, 30),
    });
  });

  it('accepts a date beyond the 30 days presets stop at', () => {
    const result = resolveCustomSnooze(
      { kind: 'at', date: '2027-06-01', time: '09:00' },
      THURSDAY_10AM,
    );
    expect(result).toEqual({ ok: true, until: at(2027, 6, 1, 9) });
    expect(result.ok && result.until - THURSDAY_10AM).toBeGreaterThan(SNOOZE_PRESET_MAX_MS);
  });

  it('counts an amount exactly from now', () => {
    expect(
      resolveCustomSnooze({ kind: 'after', amount: 90, unit: 'minutes' }, THURSDAY_10AM),
    ).toEqual({ ok: true, until: THURSDAY_10AM + 90 * MINUTE });
    expect(resolveCustomSnooze({ kind: 'after', amount: 2, unit: 'hours' }, THURSDAY_10AM)).toEqual(
      { ok: true, until: THURSDAY_10AM + 2 * HOUR },
    );
    const beforeSpringForward = at(2026, 3, 7, 23, 30);
    expect(
      resolveCustomSnooze({ kind: 'after', amount: 1, unit: 'days' }, beforeSpringForward),
    ).toEqual({ ok: true, until: beforeSpringForward + 24 * HOUR });
  });

  it('rejects an amount that is not above zero', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveCustomSnooze({ kind: 'after', amount, unit: 'hours' }, THURSDAY_10AM),
      ).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('rejects malformed dates and times', () => {
    for (const [date, time] of [
      ['2026-11-2', '09:00'],
      ['', '09:00'],
      ['2026-11-20', '9:00'],
      ['2026-11-20', '24:00'],
      ['2026-11-20', ''],
    ]) {
      expect(resolveCustomSnooze({ kind: 'at', date, time }, THURSDAY_10AM)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    }
  });
});

describe('snoozeWakeLabel', () => {
  it('counts minutes, then hours, then days, rounding up', () => {
    expect(snoozeWakeLabel(THURSDAY_10AM + 59 * MINUTE, THURSDAY_10AM)).toBe('59m');
    expect(snoozeWakeLabel(THURSDAY_10AM + 61 * MINUTE, THURSDAY_10AM)).toBe('2h');
    expect(snoozeWakeLabel(THURSDAY_10AM + 25 * HOUR, THURSDAY_10AM)).toBe('2d');
  });

  it('rounds up at each boundary and never reads below a minute', () => {
    expect(snoozeWakeLabel(THURSDAY_10AM + 44 * MINUTE + 10_000, THURSDAY_10AM)).toBe('45m');
    expect(snoozeWakeLabel(THURSDAY_10AM + 30_000, THURSDAY_10AM)).toBe('1m');
    expect(snoozeWakeLabel(THURSDAY_10AM, THURSDAY_10AM)).toBe('1m');
    expect(snoozeWakeLabel(THURSDAY_10AM + HOUR, THURSDAY_10AM)).toBe('1h');
    expect(snoozeWakeLabel(THURSDAY_10AM + 24 * HOUR, THURSDAY_10AM)).toBe('1d');
  });
});

describe('describeWake', () => {
  it('says today, tomorrow, a weekday within six days, then a date', () => {
    const wake = (until: number) => describeWake(until, THURSDAY_10AM, 'en-US');
    expect(wake(at(2026, 11, 19, 18))).toBe('today at 6:00 PM');
    expect(wake(at(2026, 11, 20, 9))).toBe('tomorrow at 9:00 AM');
    expect(wake(at(2026, 11, 23, 9))).toBe('Monday at 9:00 AM');
    expect(wake(at(2026, 11, 25, 9))).toBe('Wednesday at 9:00 AM');
    expect(wake(at(2026, 11, 26, 9))).toBe('Nov 26 at 9:00 AM');
    expect(wake(at(2026, 12, 3, 9))).toBe('Dec 3 at 9:00 AM');
    expect(wake(at(2027, 1, 5, 9))).toBe('Jan 5, 2027 at 9:00 AM');
  });
});

describe('formatClock', () => {
  it('follows the locale', () => {
    expect(formatClock(at(2026, 11, 19, 16, 40), 'en-US')).toBe('4:40 PM');
    expect(formatClock(at(2026, 11, 19, 16, 40), 'en-GB')).toBe('16:40');
  });
});

describe('describeSnoozePreset', () => {
  it('words each preset the way Settings lists it', () => {
    expect(DEFAULT_SNOOZE_PRESETS.map(describeSnoozePreset)).toEqual([
      'In 1 hour',
      'In 3 hours',
      'Today at 18:00',
      'Tomorrow at 09:00',
      'Monday at 09:00',
    ]);
    expect(describeSnoozePreset({ kind: 'at', day: 'wednesday', time: '13:30' })).toBe(
      'Wednesday at 13:30',
    );
  });
});

describe('normalizeSnoozePresets', () => {
  it('gives the defaults for anything that is not a list', () => {
    for (const value of [undefined, null, 'x', 3, {}]) {
      expect(normalizeSnoozePresets(value)).toEqual(DEFAULT_SNOOZE_PRESETS);
    }
  });

  it('drops bad entries one at a time', () => {
    expect(
      normalizeSnoozePresets([
        { kind: 'after', minutes: 60 },
        { kind: 'after', minutes: 0 },
        { kind: 'after', minutes: 1.5 },
        { kind: 'after', minutes: 43_201 },
        { kind: 'after', minutes: '60' },
        { kind: 'at', day: 'someday', time: '09:00' },
        { kind: 'at', day: 'today', time: '24:00' },
        { kind: 'at', day: 'today', time: '9:00' },
        { kind: 'later' },
        null,
        'x',
        [],
        { kind: 'at', day: 'friday', time: '17:30' },
      ]),
    ).toEqual([
      { kind: 'after', minutes: 60 },
      { kind: 'at', day: 'friday', time: '17:30' },
    ]);
  });

  it('cuts the list to its cap', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ kind: 'after', minutes: i + 1 }));
    const normalized = normalizeSnoozePresets(many);
    expect(normalized).toHaveLength(MAX_SNOOZE_PRESETS);
    expect(normalized.map((setting) => setting.kind === 'after' && setting.minutes)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('keeps duplicates, and an empty list empty', () => {
    const twice = [
      { kind: 'after', minutes: 60 },
      { kind: 'after', minutes: 60 },
    ];
    expect(normalizeSnoozePresets(twice)).toEqual(twice);
    expect(normalizeSnoozePresets([])).toEqual([]);
  });

  it('saves back only the fields a preset has', () => {
    expect(normalizeSnoozePresets([{ kind: 'after', minutes: 60, label: 'x' }])).toEqual([
      { kind: 'after', minutes: 60 },
    ]);
  });

  it('hands out a copy of the defaults, not the defaults themselves', () => {
    const normalized = normalizeSnoozePresets(undefined);
    normalized[0] = { kind: 'after', minutes: 5 };
    expect(DEFAULT_SNOOZE_PRESETS[0]).toEqual({ kind: 'after', minutes: 60 });
  });
});

describe('isSnoozePresetSetting', () => {
  it('accepts presets up to the 30-day cap', () => {
    expect(isSnoozePresetSetting({ kind: 'after', minutes: 1 })).toBe(true);
    expect(isSnoozePresetSetting({ kind: 'after', minutes: 43_200 })).toBe(true);
    expect(isSnoozePresetSetting({ kind: 'after', minutes: 43_201 })).toBe(false);
    expect(isSnoozePresetSetting({ kind: 'at', day: 'sunday', time: '23:59' })).toBe(true);
  });
});

describe('snoozePresetsEqual', () => {
  it('compares by value and order', () => {
    const copy = normalizeSnoozePresets(undefined);
    expect(snoozePresetsEqual(DEFAULT_SNOOZE_PRESETS, copy)).toBe(true);
    expect(snoozePresetsEqual(DEFAULT_SNOOZE_PRESETS, [...copy].reverse())).toBe(false);
    expect(snoozePresetsEqual(DEFAULT_SNOOZE_PRESETS, copy.slice(1))).toBe(false);
    expect(
      snoozePresetsEqual(
        [{ kind: 'at', day: 'today', time: '18:00' }],
        [{ kind: 'at', day: 'today', time: '18:30' }],
      ),
    ).toBe(false);
    expect(
      snoozePresetsEqual(
        [{ kind: 'after', minutes: 60 }],
        [{ kind: 'at', day: 'today', time: '18:00' }],
      ),
    ).toBe(false);
  });
});
