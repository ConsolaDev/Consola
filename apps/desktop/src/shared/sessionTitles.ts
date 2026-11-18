import { driverDefaultTitleModel, driverReadsConversations } from './constants';
import type { Harness } from './harness';
import type { HarnessModel } from './types';
import type { Session, SessionTitleSettings, Workspace } from './workspace';

/** Effort used for title calls when the settings name none. */
export const TITLE_EFFORT_DEFAULT = 'low';
export const MAX_TITLE_INSTRUCTIONS = 20_000;

const INVALID = 'Choose valid title settings.';

export type TitleSource =
  | { kind: 'off' }
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'ready';
      harness: Harness;
      model: string;
      effort?: string;
      fast: boolean;
      instructions?: string;
    };

/** A workspace without settings follows its default harness. */
export function titleSettingsOf(workspace: Pick<Workspace, 'sessionTitles'>): SessionTitleSettings {
  return workspace.sessionTitles ?? { source: 'default-harness' };
}

/** Harnesses that can be chosen to write titles: selectable, with a title model. */
export function titleHarnesses(harnesses: Harness[]): Harness[] {
  return harnesses.filter(
    (h) => h.enabled && !h.archived && driverDefaultTitleModel(h.driverId) !== undefined,
  );
}

/**
 * Who writes this workspace's titles. A harness that cannot is named as
 * unavailable, never replaced by another.
 */
export function resolveTitleSource(workspace: Workspace, harnesses: Harness[]): TitleSource {
  const settings = titleSettingsOf(workspace);
  if (settings.source === 'off') return { kind: 'off' };

  const pinned = settings.source === 'pinned';
  const harnessId = pinned ? settings.harnessId : workspace.defaultHarnessId;
  const harness = harnesses.find((h) => h.id === harnessId);
  if (!harness) return { kind: 'unavailable', reason: 'The title harness no longer exists.' };
  if (harness.archived) return { kind: 'unavailable', reason: `${harness.name} is archived.` };
  if (!harness.enabled) return { kind: 'unavailable', reason: `${harness.name} is turned off.` };

  // A driver with no title model cannot write titles at all, whatever model is pinned.
  const defaultModel = driverDefaultTitleModel(harness.driverId);
  if (!defaultModel) return { kind: 'unavailable', reason: `${harness.name} can’t write titles.` };
  const model = (pinned ? settings.model : undefined) ?? defaultModel;

  const effort = settings.effort ?? TITLE_EFFORT_DEFAULT;
  const instructions = settings.instructions?.trim();
  return {
    kind: 'ready',
    harness,
    model,
    effort: effort === 'default' ? undefined : effort,
    fast: settings.fast === true,
    instructions: instructions || undefined,
  };
}

function effortSupported(effort: string | undefined, model: HarnessModel): boolean {
  if (effort === undefined || !model.supportsEffort) return false;
  const levels = model.supportedEffortLevels;
  return !levels || levels.length === 0 || levels.includes(effort);
}

/** Effort and Fast to send, dropping whatever the model does not support. */
export function titleCallOptions(
  source: { effort?: string; fast: boolean },
  model: HarnessModel | undefined,
): { effort?: string; fast?: true } {
  const options: { effort?: string; fast?: true } = {};
  if (!model) return options;
  if (source.effort !== undefined && effortSupported(source.effort, model)) {
    options.effort = source.effort;
  }
  if (source.fast && model.supportsFastMode) options.fast = true;
  return options;
}

/**
 * The effort the settings show for a model: what a title call would send, or
 * `'default'` when none is sent, so an effort the model does not offer reads
 * as Default instead of a level the menu cannot check.
 */
export function shownTitleEffort(settings: SessionTitleSettings, model: HarnessModel): string {
  const sent = titleCallOptions(
    { effort: settings.effort ?? TITLE_EFFORT_DEFAULT, fast: false },
    model,
  ).effort;
  return sent ?? 'default';
}

/** Drops an effort or Fast the model lacks; unchanged while the model is not loaded. */
export function reconcileTitleSettings(
  settings: SessionTitleSettings,
  model: HarnessModel | undefined,
): SessionTitleSettings {
  if (!model) return settings;
  const next = { ...settings };
  if (
    next.effort !== undefined &&
    next.effort !== 'default' &&
    !effortSupported(next.effort, model)
  ) {
    delete next.effort;
  }
  if (next.fast && !model.supportsFastMode) delete next.fast;
  return next;
}

/** Whether the session menu offers Regenerate title. */
export function canRegenerateTitle(
  workspace: Workspace,
  session: Session,
  harnesses: Harness[],
): boolean {
  if (session.kind === 'assistant') return false;
  if (titleSettingsOf(workspace).source === 'off') return false;
  const harness = harnesses.find((h) => h.id === session.harnessId);
  return driverReadsConversations(harness?.driverId);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(INVALID);
  return value;
}

/** Rebuilds settings from an allow-list; throws on anything malformed. */
export function sanitizeTitleSettings(value: unknown): SessionTitleSettings {
  if (typeof value !== 'object' || value === null) throw new Error(INVALID);
  const raw = value as Record<string, unknown>;
  const source = raw.source;
  if (source !== 'off' && source !== 'default-harness' && source !== 'pinned') {
    throw new Error(INVALID);
  }
  const harnessId = optionalString(raw.harnessId);
  const model = optionalString(raw.model);
  const effort = optionalString(raw.effort);
  const instructions = optionalString(raw.instructions);
  if (raw.fast !== undefined && typeof raw.fast !== 'boolean') throw new Error(INVALID);

  const settings: SessionTitleSettings = { source };
  if (source === 'pinned') {
    if (!harnessId) throw new Error(INVALID);
    settings.harnessId = harnessId;
    if (model) settings.model = model;
  }
  if (effort) settings.effort = effort;
  if (raw.fast === true) settings.fast = true;
  const trimmed = instructions?.trim().slice(0, MAX_TITLE_INSTRUCTIONS).trim();
  if (trimmed) settings.instructions = trimmed;
  return settings;
}
