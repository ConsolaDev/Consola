import { describe, expect, it } from 'vitest';
import type { Harness } from './harness';
import {
  canRegenerateTitle,
  reconcileTitleSettings,
  resolveTitleSource,
  sanitizeTitleSettings,
  shownTitleEffort,
  titleCallOptions,
  titleHarnesses,
} from './sessionTitles';
import type { HarnessModel } from './types';
import type { Session, Workspace } from './workspace';

const harness = (over: Partial<Harness>): Harness => ({
  id: 'claude-a',
  driverId: 'claude',
  name: 'Claude A',
  accentColor: '#000',
  enabled: true,
  archived: false,
  isBuiltIn: false,
  extraArgs: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});
const claudeA = harness({});
const claudeB = harness({ id: 'claude-b', name: 'Claude B' });
const codex = harness({ id: 'codex', driverId: 'codex', name: 'Codex' });

const ws = (over: Partial<Workspace>): Workspace =>
  ({ id: 'w', defaultHarnessId: 'claude-a', sessions: [], ...over }) as unknown as Workspace;
const session = (over: Partial<Session>): Session =>
  ({ id: 's', kind: 'interactive', harnessId: 'claude-a', ...over }) as unknown as Session;

const m: HarnessModel = {
  value: 'haiku',
  resolvedModel: 'h',
  displayName: 'Haiku',
  description: '',
};

describe('resolveTitleSource', () => {
  it('follows the default harness with its driver’s default title model and low effort', () => {
    expect(resolveTitleSource(ws({ defaultHarnessId: 'claude-a' }), [claudeA])).toEqual({
      kind: 'ready',
      harness: claudeA,
      model: 'haiku',
      effort: 'low',
      fast: false,
    });
  });
  it('is off when the workspace says so', () => {
    expect(resolveTitleSource(ws({ sessionTitles: { source: 'off' } }), [claudeA]).kind).toBe(
      'off',
    );
  });
  it('names why a pinned harness is unusable, and never substitutes another', () => {
    const src = resolveTitleSource(
      ws({ sessionTitles: { source: 'pinned', harnessId: 'claude-b' } }),
      [claudeA, { ...claudeB, enabled: false }],
    );
    expect(src).toEqual({ kind: 'unavailable', reason: expect.stringContaining('Claude B') });
  });
  it('words each unavailable reason', () => {
    const pinned = (id: string) => ws({ sessionTitles: { source: 'pinned', harnessId: id } });
    expect(resolveTitleSource(pinned('gone'), [claudeA])).toEqual({
      kind: 'unavailable',
      reason: 'The title harness no longer exists.',
    });
    expect(resolveTitleSource(pinned('claude-b'), [{ ...claudeB, archived: true }])).toEqual({
      kind: 'unavailable',
      reason: 'Claude B is archived.',
    });
    expect(resolveTitleSource(pinned('claude-b'), [{ ...claudeB, enabled: false }])).toEqual({
      kind: 'unavailable',
      reason: 'Claude B is turned off.',
    });
    expect(resolveTitleSource(pinned('codex'), [codex])).toEqual({
      kind: 'unavailable',
      reason: 'Codex can’t write titles.',
    });
  });
  it('is unavailable for a harness whose driver cannot write titles', () => {
    expect(resolveTitleSource(ws({ defaultHarnessId: 'codex' }), [codex]).kind).toBe('unavailable');
  });
  it("passes 'default' effort as no effort, and trimmed instructions", () => {
    const src = resolveTitleSource(
      ws({
        sessionTitles: { source: 'default-harness', effort: 'default', instructions: '  Short.  ' },
      }),
      [claudeA],
    );
    expect(src).toMatchObject({ kind: 'ready', effort: undefined, instructions: 'Short.' });
  });
  it('uses the pinned model only when pinned, else the driver default', () => {
    const pinned = resolveTitleSource(
      ws({ sessionTitles: { source: 'pinned', harnessId: 'claude-b', model: 'opus', fast: true } }),
      [claudeB],
    );
    expect(pinned).toMatchObject({ kind: 'ready', model: 'opus', fast: true });
    const followed = resolveTitleSource(
      ws({ sessionTitles: { source: 'default-harness', model: 'opus' } }),
      [claudeA],
    );
    expect(followed).toMatchObject({ kind: 'ready', model: 'haiku' });
  });
  it('is unavailable when pinned with no model and the driver has no default', () => {
    expect(
      resolveTitleSource(ws({ sessionTitles: { source: 'pinned', harnessId: 'codex' } }), [codex])
        .kind,
    ).toBe('unavailable');
  });
  it('is unavailable when pinned with a model to a harness whose driver cannot write titles', () => {
    expect(
      resolveTitleSource(
        ws({ sessionTitles: { source: 'pinned', harnessId: 'codex', model: 'gpt-5-mini' } }),
        [codex],
      ),
    ).toEqual({ kind: 'unavailable', reason: 'Codex can’t write titles.' });
  });
});
describe('titleCallOptions', () => {
  it('sends effort and fast only when the model supports them', () => {
    expect(
      titleCallOptions(
        { effort: 'low', fast: true },
        { ...m, supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      ),
    ).toEqual({ effort: 'low' });
    expect(
      titleCallOptions({ effort: 'low', fast: true }, { ...m, supportsFastMode: true }),
    ).toEqual({ fast: true });
    expect(
      titleCallOptions(
        { effort: 'max', fast: false },
        { ...m, supportsEffort: true, supportedEffortLevels: ['low'] },
      ),
    ).toEqual({});
    expect(titleCallOptions({ effort: 'low', fast: true }, undefined)).toEqual({});
  });
});
describe('shownTitleEffort', () => {
  const levels = (supportedEffortLevels: string[]): HarnessModel => ({
    ...m,
    supportsEffort: true,
    supportedEffortLevels,
  });
  it('shows the effort a title call sends, and Default when the model does not offer it', () => {
    expect(shownTitleEffort({ source: 'default-harness' }, levels(['low', 'high']))).toBe('low');
    expect(shownTitleEffort({ source: 'default-harness' }, levels(['medium', 'high']))).toBe(
      'default',
    );
    expect(
      shownTitleEffort({ source: 'default-harness', effort: 'high' }, levels(['medium', 'high'])),
    ).toBe('high');
    expect(
      shownTitleEffort({ source: 'default-harness', effort: 'default' }, levels(['low'])),
    ).toBe('default');
    expect(shownTitleEffort({ source: 'default-harness' }, m)).toBe('default');
  });
});
describe('titleHarnesses', () => {
  it('lists only selectable harnesses whose driver can write titles', () => {
    expect(
      titleHarnesses([claudeA, { ...claudeB, archived: true }, codex]).map((h) => h.id),
    ).toEqual(['claude-a']);
  });
});
describe('reconcileTitleSettings', () => {
  it('drops an effort or Fast the new model lacks, and keeps everything when the model is unknown', () => {
    const s = {
      source: 'pinned',
      harnessId: 'claude-a',
      model: 'opus',
      effort: 'high',
      fast: true,
    } as const;
    expect(
      reconcileTitleSettings(s, { ...m, supportsEffort: true, supportedEffortLevels: ['low'] }),
    ).toEqual({ source: 'pinned', harnessId: 'claude-a', model: 'opus' });
    expect(reconcileTitleSettings(s, undefined)).toBe(s);
  });
});
describe('canRegenerateTitle', () => {
  it('is hidden for the Assistant, when titles are off, and for a driver that cannot read conversations', () => {
    const unreadable = harness({ id: 'x', driverId: 'unknown' as never });
    const harnesses = [claudeA, codex, unreadable];
    expect(canRegenerateTitle(ws({}), session({ kind: 'assistant' }), harnesses)).toBe(false);
    expect(
      canRegenerateTitle(ws({ sessionTitles: { source: 'off' } }), session({}), harnesses),
    ).toBe(false);
    expect(canRegenerateTitle(ws({}), session({ harnessId: 'x' }), harnesses)).toBe(false);
    expect(canRegenerateTitle(ws({}), session({}), harnesses)).toBe(true);
  });
});
describe('sanitizeTitleSettings', () => {
  it('requires a harness id when pinned and drops it otherwise', () => {
    expect(() => sanitizeTitleSettings({ source: 'pinned' })).toThrow(
      'Choose valid title settings.',
    );
    expect(sanitizeTitleSettings({ source: 'off', harnessId: 'x' })).toEqual({ source: 'off' });
  });
  it('drops model unless pinned', () => {
    expect(sanitizeTitleSettings({ source: 'default-harness', model: 'opus' })).toEqual({
      source: 'default-harness',
    });
    expect(sanitizeTitleSettings({ source: 'pinned', harnessId: 'h', model: 'opus' })).toEqual({
      source: 'pinned',
      harnessId: 'h',
      model: 'opus',
    });
  });
  it('trims instructions, caps them at 20,000 characters, and drops empty ones', () => {
    expect(sanitizeTitleSettings({ source: 'default-harness', instructions: '   ' })).toEqual({
      source: 'default-harness',
    });
    expect(
      sanitizeTitleSettings({ source: 'default-harness', instructions: 'x'.repeat(20_010) })
        .instructions,
    ).toHaveLength(20_000);
  });
  it('keeps fast only when true and rejects unknown sources', () => {
    expect(sanitizeTitleSettings({ source: 'default-harness', fast: true }).fast).toBe(true);
    expect('fast' in sanitizeTitleSettings({ source: 'default-harness', fast: false })).toBe(false);
    expect(() => sanitizeTitleSettings({ source: 'nope' })).toThrow('Choose valid title settings.');
    expect(() => sanitizeTitleSettings(null)).toThrow('Choose valid title settings.');
    expect(() => sanitizeTitleSettings({ source: 'off', effort: 3 })).toThrow(
      'Choose valid title settings.',
    );
  });
});
