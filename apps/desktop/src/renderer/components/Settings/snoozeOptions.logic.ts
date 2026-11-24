import {
  DEFAULT_SNOOZE_PRESETS,
  isSnoozePresetSetting,
  MAX_SNOOZE_MINUTES,
  resolveSnoozePresets,
  snoozePresetsEqual,
} from '../../../shared/snooze';
import type { SnoozePresetDay, SnoozePresetSetting } from '../../../shared/snooze';

/** One row of the editor: a choice, and a key that stays with it while it is edited and moved. */
export interface DraftRow {
  key: string;
  setting: SnoozePresetSetting;
}

export type DurationUnit = 'minutes' | 'hours' | 'days';

const MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

let nextKey = 1;
const freshKey = () => `snooze-option-${nextKey++}`;

/** The editor's rows for a stored list, each with a new key. */
export function toDraft(presets: readonly SnoozePresetSetting[]): DraftRow[] {
  return presets.map((setting) => ({ key: freshKey(), setting }));
}

/**
 * The draft after main says what is stored. Its own write coming back is an
 * echo: the draft stands, keys and all, so a row being typed in keeps focus.
 * Anything else (another window's edit) replaces it.
 */
export function reconcile(draft: DraftRow[], stored: readonly SnoozePresetSetting[]): DraftRow[] {
  return snoozePresetsEqual(storable(draft), stored) ? draft : toDraft(stored);
}

/** What a draft writes: only the rows that are whole. One being typed in waits until it is. */
export function storable(draft: DraftRow[]): SnoozePresetSetting[] {
  return draft.map((row) => row.setting).filter(isSnoozePresetSetting);
}

/** Whether the list is the one Consola ships with. */
export function isDefault(presets: readonly SnoozePresetSetting[]): boolean {
  return snoozePresetsEqual(presets, DEFAULT_SNOOZE_PRESETS);
}

/** A duration in the largest unit that holds it whole: 180 minutes is 3 hours, 2880 is 2 days. */
export function durationParts(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes >= MINUTES.days && minutes % MINUTES.days === 0)
    return { amount: minutes / MINUTES.days, unit: 'days' };
  if (minutes >= MINUTES.hours && minutes % MINUTES.hours === 0)
    return { amount: minutes / MINUTES.hours, unit: 'hours' };
  return { amount: minutes, unit: 'minutes' };
}

/** An amount and unit as minutes. Not checked: `optionProblem` says what is wrong with it. */
export function toMinutes(amount: number, unit: DurationUnit): number {
  return amount * MINUTES[unit];
}

/** Why a row cannot be stored, in words, or null when it can. */
export function optionProblem(setting: SnoozePresetSetting): string | null {
  if (setting.kind === 'after') {
    if (!Number.isInteger(setting.minutes) || setting.minutes < 1)
      return 'Enter a whole number above zero.';
    if (setting.minutes > MAX_SNOOZE_MINUTES) return 'A choice can be at most 30 days away.';
    return null;
  }
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(setting.time) ? null : 'Pick a time.';
}

/** What the menu will say for this row right now, or why it is not in the menu. */
export function previewOf(
  setting: SnoozePresetSetting,
  now: number,
  locale?: string,
): { label: string; time: string } | { hidden: string } {
  if (optionProblem(setting)) return { hidden: '' };
  const [row] = resolveSnoozePresets([setting], now, locale);
  if (!row) return { hidden: 'Not in the menu again until tomorrow: that time has passed today.' };
  return { label: row.label, time: row.timeLabel };
}

/**
 * The order the menu shows: soonest first, a choice hidden for today last.
 * The editor re-sorts into it only when focus leaves the list, so a row
 * never jumps away from under the person typing in it.
 */
export function menuOrder(draft: DraftRow[], now: number): DraftRow[] {
  const wake = (row: DraftRow) => {
    if (optionProblem(row.setting)) return Number.POSITIVE_INFINITY;
    return resolveSnoozePresets([row.setting], now)[0]?.wakeAt ?? Number.POSITIVE_INFINITY;
  };
  return draft
    .map((row, index) => ({ row, index, at: wake(row) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ row }) => row);
}

/** What Add offers: the first of these the list does not already have. */
const CANDIDATES: SnoozePresetSetting[] = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
  { kind: 'after', minutes: 30 },
  { kind: 'after', minutes: 24 * 60 },
  { kind: 'at', day: 'friday', time: '17:00' },
  { kind: 'at', day: 'tomorrow', time: '14:00' },
];

/** A new row for Add: the next useful choice not in the list, or "in 2 days" and on from there. */
export function nextCandidate(presets: readonly SnoozePresetSetting[]): SnoozePresetSetting {
  const has = (candidate: SnoozePresetSetting) =>
    presets.some((preset) => snoozePresetsEqual([preset], [candidate]));
  const found = CANDIDATES.find((candidate) => !has(candidate));
  if (found) return found;
  for (let days = 2; days <= 30; days++) {
    const candidate: SnoozePresetSetting = { kind: 'after', minutes: days * 24 * 60 };
    if (!has(candidate)) return candidate;
  }
  return { kind: 'after', minutes: 60 };
}

/** The days an `at` choice can name, in the order a person reads a week. */
export const PRESET_DAYS: { value: SnoozePresetDay; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];
