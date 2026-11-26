import { describe, expect, it } from 'vitest';
import { DEFAULT_SNOOZE_PRESETS } from '../../../shared/snooze';
import type { SnoozePresetSetting } from '../../../shared/snooze';
import {
  durationParts,
  isDefault,
  menuOrder,
  nextCandidate,
  optionProblem,
  previewOf,
  reconcile,
  storable,
  toDraft,
} from './snoozeOptions.logic';

const at = (day: 'today' | 'tomorrow', time: string): SnoozePresetSetting => ({
  kind: 'at',
  day,
  time,
});
const inMinutes = (minutes: number): SnoozePresetSetting => ({ kind: 'after', minutes });
const NOON = new Date(2026, 10, 19, 12, 0).getTime();

describe('reconcile', () => {
  it('keeps the draft, keys and all, when main echoes its own write', () => {
    const draft = toDraft([inMinutes(60), at('tomorrow', '09:00')]);
    expect(reconcile(draft, [inMinutes(60), at('tomorrow', '09:00')])).toBe(draft);
  });

  it('keeps a row still being typed: it is not stored yet', () => {
    const draft = [...toDraft([inMinutes(60)]), { key: 'typing', setting: inMinutes(Number.NaN) }];
    expect(reconcile(draft, [inMinutes(60)])).toBe(draft);
  });

  it('takes another window’s edit', () => {
    const draft = toDraft([inMinutes(60)]);
    expect(reconcile(draft, [inMinutes(90)]).map((row) => row.setting)).toEqual([inMinutes(90)]);
  });
});

describe('storable', () => {
  it('drops rows that are not whole', () => {
    expect(storable(toDraft([inMinutes(0), inMinutes(60), at('today', '')]))).toEqual([
      inMinutes(60),
    ]);
  });
});

describe('durationParts', () => {
  it('uses the largest unit that holds it whole', () => {
    expect(durationParts(180)).toEqual({ amount: 3, unit: 'hours' });
    expect(durationParts(2880)).toEqual({ amount: 2, unit: 'days' });
    expect(durationParts(90)).toEqual({ amount: 90, unit: 'minutes' });
  });
});

describe('optionProblem', () => {
  it('says what is wrong in words', () => {
    expect(optionProblem(inMinutes(0))).toBe('Enter a whole number above zero.');
    expect(optionProblem(inMinutes(43_201))).toBe('A choice can be at most 30 days away.');
    expect(optionProblem(at('today', ''))).toBe('Pick a time.');
    expect(optionProblem(inMinutes(60))).toBeNull();
  });
});

describe('previewOf', () => {
  it('says what the menu will show, or that a passed today is hidden', () => {
    expect(previewOf(at('today', '18:00'), NOON, 'en-US')).toEqual({
      label: 'This evening',
      time: expect.stringMatching(/^6:00\sPM$/),
    });
    expect(previewOf(at('today', '09:00'), NOON, 'en-US')).toEqual({
      hidden: 'Not in the menu again until tomorrow: that time has passed today.',
    });
  });
});

describe('menuOrder', () => {
  it('sorts soonest first, a hidden today and a broken row last', () => {
    const draft = toDraft([
      at('tomorrow', '09:00'),
      inMinutes(0),
      at('today', '09:00'),
      inMinutes(60),
    ]);
    expect(menuOrder(draft, NOON).map((row) => row.setting)).toEqual([
      inMinutes(60),
      at('tomorrow', '09:00'),
      inMinutes(0),
      at('today', '09:00'),
    ]);
  });
});

describe('nextCandidate and isDefault', () => {
  it('offers the first useful choice the list lacks', () => {
    expect(nextCandidate(DEFAULT_SNOOZE_PRESETS)).toEqual(inMinutes(30));
    expect(nextCandidate([])).toEqual(inMinutes(60));
  });

  it('knows the shipped list', () => {
    expect(isDefault(DEFAULT_SNOOZE_PRESETS)).toBe(true);
    expect(isDefault([inMinutes(60)])).toBe(false);
  });
});
