import { automationLines } from '@consola/factory-spec';
import type { Automation, AutomationMode } from '@consola/factory-spec';
import type { FactoryFile } from './factory.js';
import type { AppliesToKind, LineRange, RunTrigger } from './run.js';

/**
 * The file behind an automation run: where its automation is written in the factory version the
 * run executed, the whole file's text, the automation's own lines in it, and what its entry says
 * of how it starts. The app reads it from the stored version on every read, never from the run's
 * record, so it is the file as it was then, whatever the factory holds now. A request has none:
 * its orchestrator has no file in Consola yet.
 */
export type RunSource = {
  /** The file the automation is written in: `automations/<name>.yaml`, or `factory.yml`. */
  readonly path: string;
  /** The factory version the run executed. */
  readonly version: number;
  /** The factory's latest version now. */
  readonly latestVersion: number;
  /** The whole file, at that version. */
  readonly text: string;
  /** The automation's own lines: the whole file for `automations/<name>.yaml`. */
  readonly range: LineRange;
  readonly trigger: { readonly kind: RunTrigger; readonly detail: string | null };
  readonly mode: AutomationMode;
  readonly appliesTo: AppliesToKind[];
};

/** How many lines `text` holds: a last line break ends a line, it starts none. */
function linesIn(text: string): number {
  const breaks = text.split('\n').length - 1;
  return text === '' ? 1 : text.endsWith('\n') ? breaks : breaks + 1;
}

/** What starts the automation, in the words its entry writes: the schedule, events or check. */
function triggerOf(automation: Automation): RunSource['trigger'] {
  const { trigger } = automation;
  switch (trigger.kind) {
    case 'cron':
      return { kind: 'cron', detail: trigger.cron };
    case 'event':
      return { kind: 'event', detail: trigger.events.join(', ') };
    case 'poll':
      return { kind: 'poll', detail: trigger.run };
    case 'manual':
      return { kind: 'manual', detail: null };
  }
}

/**
 * The file behind a run of `automation`, read from `files` (the factory version `version`), with
 * each of its steps' lines by step id; null when the version holds no file the automation names.
 * Lines the file's shape does not give leave the whole file as the automation's, and its steps
 * with none.
 */
export function sourceOf(
  automation: Automation,
  files: readonly FactoryFile[],
  version: number,
  latestVersion: number,
): { source: RunSource; stepLines: Map<string, LineRange> } | null {
  const path = automation.file ?? 'factory.yml';
  const text = files.find((file) => file.path === path)?.content;
  if (text === undefined) return null;
  const lines = automationLines(path, text, automation.name);
  const stepLines = new Map<string, LineRange>();
  (automation.steps ?? []).forEach((step, index) => {
    const range = lines?.steps[index];
    if (range) stepLines.set(step.id, range);
  });
  return {
    source: {
      path,
      version,
      latestVersion,
      text,
      range: lines?.range ?? { start: 1, end: linesIn(text) },
      trigger: triggerOf(automation),
      mode: automation.mode,
      appliesTo: [...(automation.appliesTo ?? [])],
    },
    stepLines,
  };
}
