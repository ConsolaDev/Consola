/**
 * Snooze parks a session until a time. This is the local-time arithmetic
 * behind the snooze menu and its Settings editor. Nothing here reads the
 * clock: every caller passes `now`, so main and the renderer agree and tests
 * can pin the hour.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_MINUTES = 24 * 60;

export type SnoozePresetDay =
  | 'today'
  | 'tomorrow'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

type Weekday = Exclude<SnoozePresetDay, 'today' | 'tomorrow'>;

/**
 * One snooze menu option as Settings stores it. `after` wakes a fixed time
 * from the pick. `at` wakes at a local time ("HH:MM") on a named day, where a
 * weekday is always its next occurrence after today.
 */
export type SnoozePresetSetting =
  | { kind: 'after'; minutes: number }
  | { kind: 'at'; day: SnoozePresetDay; time: string };

type AtSetting = Extract<SnoozePresetSetting, { kind: 'at' }>;

/** What a snooze waits for: an instant, or the harness's usage limit lifting. */
export type SnoozeWhen = { until: number } | { untilLimitResets: true };

/** The menu has room for this many presets; Custom… is always offered besides. */
export const MAX_SNOOZE_PRESETS = 8;

/** Presets stop at 30 days. A custom date has no cap. */
export const MAX_SNOOZE_MINUTES = 43_200;

/** The preset cap in milliseconds. */
export const SNOOZE_PRESET_MAX_MS = MAX_SNOOZE_MINUTES * MINUTE_MS;

/** What a person who never opened Settings is offered. */
export const DEFAULT_SNOOZE_PRESETS: ReadonlyArray<SnoozePresetSetting> = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
];

const PRESET_DAYS: ReadonlyArray<string> = [
  'today',
  'tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a stored value is a preset Settings could have written. */
export function isSnoozePresetSetting(value: unknown): value is SnoozePresetSetting {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'after') {
    const { minutes } = candidate;
    return (
      typeof minutes === 'number' &&
      Number.isInteger(minutes) &&
      minutes >= 1 &&
      minutes <= MAX_SNOOZE_MINUTES
    );
  }
  if (candidate.kind === 'at') {
    return (
      typeof candidate.day === 'string' &&
      PRESET_DAYS.includes(candidate.day) &&
      typeof candidate.time === 'string' &&
      TIME_PATTERN.test(candidate.time)
    );
  }
  return false;
}

/**
 * Presets as read from storage. Bad entries drop one at a time, so a hand
 * edit cannot cost the person the rest of their menu. Duplicates stay: the
 * menu collapses them, and the editor should show what was saved. An empty
 * list is a choice (the menu offers only Custom…), not a missing value.
 */
export function normalizeSnoozePresets(value: unknown): SnoozePresetSetting[] {
  if (!Array.isArray(value)) return DEFAULT_SNOOZE_PRESETS.map(copyPreset);
  return value.filter(isSnoozePresetSetting).map(copyPreset).slice(0, MAX_SNOOZE_PRESETS);
}

// Rebuilt rather than passed through, so extra keys from a hand edit are not saved back.
function copyPreset(setting: SnoozePresetSetting): SnoozePresetSetting {
  return setting.kind === 'after'
    ? { kind: 'after', minutes: setting.minutes }
    : { kind: 'at', day: setting.day, time: setting.time };
}

/** Whether two preset lists are the same, in the same order. */
export function snoozePresetsEqual(
  a: ReadonlyArray<SnoozePresetSetting>,
  b: ReadonlyArray<SnoozePresetSetting>,
): boolean {
  return a.length === b.length && a.every((setting, i) => presetEqual(setting, b[i]));
}

function presetEqual(a: SnoozePresetSetting, b: SnoozePresetSetting): boolean {
  if (a.kind === 'after') return b.kind === 'after' && a.minutes === b.minutes;
  return b.kind === 'at' && a.day === b.day && a.time === b.time;
}

/** A preset as Settings words it: "In 3 hours", "Today at 18:00", "Monday at 09:00". */
export function describeSnoozePreset(setting: SnoozePresetSetting): string {
  if (setting.kind === 'after') return durationLabel(setting.minutes);
  return `${capitalize(setting.day)} at ${setting.time}`;
}

/** "In 3 hours", "In 90 minutes", "In 2 days": the largest unit that divides evenly. */
function durationLabel(minutes: number): string {
  if (minutes % DAY_MINUTES === 0) return `In ${count(minutes / DAY_MINUTES, 'day')}`;
  if (minutes % 60 === 0) return `In ${count(minutes / 60, 'hour')}`;
  return `In ${count(minutes, 'minute')}`;
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A clock time in the locale's style: "4:40 PM", or "16:40" where the clock is 24-hour. */
export function formatClock(ms: number, locale?: string): string {
  // Some ICU builds put a narrow no-break space before AM/PM and some do not.
  // Main and the renderer run different builds, so settle on a plain space.
  return new Date(ms)
    .toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
    .replace(/ /g, ' ');
}

/** One row of the snooze menu. */
export interface ResolvedSnoozePreset {
  /** Position in Settings. */
  index: number;
  setting: SnoozePresetSetting;
  /** "In 1 hour", "Tomorrow", "Next week". */
  label: string;
  /** "4:40 PM", or "Mon 9:00 AM" when the label does not already name the day. */
  timeLabel: string;
  wakeAt: number;
}

/** The snooze menu: soonest first, a passed "today" left out, one row per wake minute. */
export function resolveSnoozePresets(
  presets: ReadonlyArray<SnoozePresetSetting>,
  now: number,
  locale?: string,
): ResolvedSnoozePreset[] {
  const rows: ResolvedSnoozePreset[] = [];
  presets.forEach((setting, index) => {
    const row = resolvePreset(setting, index, now, locale);
    if (row) rows.push(row);
  });
  // By minute, so a duration (which keeps the clock's seconds) ties with a set
  // time in the same minute. The sort is stable, so the first in Settings wins.
  const wakeMinute = (row: ResolvedSnoozePreset) => Math.floor(row.wakeAt / MINUTE_MS);
  rows.sort((a, b) => wakeMinute(a) - wakeMinute(b));
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(wakeMinute(row))) return false;
    seen.add(wakeMinute(row));
    return true;
  });
}

/**
 * A menu row as picked. A duration counts from the pick, not from when the
 * menu opened. A set time keeps the wake the menu showed, so a menu left open
 * past midnight cannot slide "Tomorrow" a day later; once that time has
 * passed there is nothing to keep, and the answer is null.
 */
export function pickSnoozePreset(
  row: ResolvedSnoozePreset,
  now: number,
  locale?: string,
): ResolvedSnoozePreset | null {
  if (row.setting.kind === 'after') return resolvePreset(row.setting, row.index, now, locale);
  return row.wakeAt > now ? row : null;
}

function resolvePreset(
  setting: SnoozePresetSetting,
  index: number,
  now: number,
  locale: string | undefined,
): ResolvedSnoozePreset | null {
  if (setting.kind === 'after') {
    // Exact, not calendar: one day is 24 hours even across a clock change.
    const wakeAt = now + setting.minutes * MINUTE_MS;
    return {
      index,
      setting,
      label: durationLabel(setting.minutes),
      timeLabel: timeLabel(wakeAt, now, false, locale),
      wakeAt,
    };
  }
  const daysAhead = daysUntil(setting.day, now);
  // Advance by calendar date, then set the clock. Adding 24-hour steps would
  // land an hour off (or on the wrong day) across a DST change.
  const wake = new Date(now);
  wake.setDate(wake.getDate() + daysAhead);
  wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
  const wakeAt = wake.getTime();
  // Only a "today" can have passed; it comes back tomorrow.
  if (wakeAt <= now) return null;
  // "Next week" is the one set-time label that does not name the day.
  const labelNamesDay = !(setting.day === 'monday' && daysAhead > 1);
  return {
    index,
    setting,
    label: atLabel(setting, daysAhead),
    timeLabel: timeLabel(wakeAt, now, labelNamesDay, locale),
    wakeAt,
  };
}

function timeLabel(
  wakeAt: number,
  now: number,
  labelNamesDay: boolean,
  locale: string | undefined,
): string {
  const clock = formatClock(wakeAt, locale);
  if (labelNamesDay || calendarDaysBetween(now, wakeAt) === 0) return clock;
  return `${new Date(wakeAt).toLocaleDateString(locale, { weekday: 'short' })} ${clock}`;
}

function daysUntil(day: SnoozePresetDay, now: number): number {
  if (day === 'today') return 0;
  if (day === 'tomorrow') return 1;
  // Never 0: a weekday means the next one, even when today is that day.
  return (WEEKDAY_INDEX[day] - new Date(now).getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function atLabel(setting: AtSetting, daysAhead: number): string {
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? 'This morning' : hour < 17 ? 'This afternoon' : 'This evening';
  }
  if (daysAhead === 1) return 'Tomorrow';
  if (setting.day === 'monday') return 'Next week';
  const name = capitalize(setting.day);
  return daysAhead === 7 ? `Next ${name}` : name;
}

/** Local calendar days from one instant to another: 0 for the same date. */
function calendarDaysBetween(from: number, to: number): number {
  return (localDate(to) - localDate(from)) / DAY_MS;
}

// The local date as a UTC midnight, so subtracting two is a whole number of days.
function localDate(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A snooze picked under Custom…: a local date and time, or an amount from now. */
export type CustomSnoozeInput =
  | { kind: 'at'; date: string /* YYYY-MM-DD */; time: string /* HH:MM */ }
  | { kind: 'after'; amount: number; unit: 'minutes' | 'hours' | 'days' };

export type CustomSnoozeRejection = 'invalid' | 'no-such-date' | 'no-such-time' | 'past';

/** Either the wake instant or why there is none, worded for the person. */
export type CustomSnoozeResult =
  | { ok: true; until: number }
  | { ok: false; reason: CustomSnoozeRejection; message: string };

const UNIT_MS = { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS };

/** Custom… input as a wake instant, or the reason it cannot be one. */
export function resolveCustomSnooze(input: CustomSnoozeInput, now: number): CustomSnoozeResult {
  let until: number;
  if (input.kind === 'after') {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return reject('invalid', 'Enter an amount above zero.');
    }
    // Exact, like a preset duration: a day is 24 hours.
    until = now + input.amount * UNIT_MS[input.unit];
  } else {
    const date = DATE_PATTERN.exec(input.date);
    const time = TIME_PATTERN.exec(input.time);
    if (!date || !time) return reject('invalid', 'Pick a date and a time.');
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const [hours, minutes] = [Number(time[1]), Number(time[2])];
    // Date would quietly roll February 30 into March.
    if (!dateExists(year, month, day)) return reject('no-such-date', 'That date does not exist.');
    const wake = new Date(year, month - 1, day, hours, minutes);
    until = wake.getTime();
    if (until > now && !sameLocalTime(wake, year, month, day, hours, minutes)) {
      // The clocks jump over it, and Date would quietly move it an hour on.
      return reject('no-such-time', 'The clocks skip that time on that day. Pick another.');
    }
  }
  if (Number.isNaN(new Date(until).getTime())) return reject('invalid', 'That is too far away.');
  if (until <= now) return reject('past', 'That time has passed. Pick another.');
  return { ok: true, until };
}

function reject(reason: CustomSnoozeRejection, message: string): CustomSnoozeResult {
  return { ok: false, reason, message };
}

function dateExists(year: number, month: number, day: number): boolean {
  // setUTCFullYear, not Date.UTC: the latter reads years 0–99 as 1900–1999.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function sameLocalTime(
  date: Date,
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
): boolean {
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hours &&
    date.getMinutes() === minutes
  );
}

/** A snooze countdown: "45m", "2h", "3d", each rounded up. */
export function snoozeWakeLabel(until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < DAY_MINUTES) return `${Math.ceil(minutes / 60)}h`;
  return `${Math.ceil(minutes / DAY_MINUTES)}d`;
}

/**
 * A wake time for toasts and tooltips: "today at 6:00 PM", "tomorrow at 9:00
 * AM", "Monday at 9:00 AM" within the coming week, otherwise "Dec 3 at 9:00
 * AM". A weekday stops at six days out, where it would also name today.
 */
export function describeWake(until: number, now: number, locale?: string): string {
  const clock = formatClock(until, locale);
  const days = calendarDaysBetween(now, until);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  const wake = new Date(until);
  if (days > 1 && days <= 6) {
    return `${wake.toLocaleDateString(locale, { weekday: 'long' })} at ${clock}`;
  }
  // A custom date has no cap, so one in another year says which.
  const otherYear = wake.getFullYear() !== new Date(now).getFullYear();
  const date = wake.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(otherYear ? { year: 'numeric' } : {}),
  });
  return `${date} at ${clock}`;
}
