import type { LineRange, RunSource } from './runs';
import { type YamlToken, yamlTokens } from './yamlTokens';

/**
 * The file behind an automation run, as its File view and its info panel's Definition say it:
 * the automation's file at the version the run executed (`RunSource`), its lines shaded
 * (`yamlTokens`), each knowing whether it is the automation's own and which step's it is.
 */

/** One line of a run's file, as the File view draws it. */
export type FileLine = {
  /** From 1, as an editor counts. */
  number: number;
  tokens: YamlToken[];
  /** The automation's own line: in a `factory.yml` that holds others too, the rest is quieter. */
  own: boolean;
  /** The step whose lines hold it, if any. */
  step: string | null;
};

/** Whether `line` is within `range`, both ends included. */
export function inRange(line: number, range: LineRange): boolean {
  return line >= range.start && line <= range.end;
}

/** The file's lines, shaded, each with whose it is. A last newline makes no empty last line. */
export function fileLines(
  source: Pick<RunSource, 'text' | 'range'>,
  steps: readonly { id: string; range: LineRange | null }[],
): FileLine[] {
  return yamlTokens(source.text.replace(/\n+$/, '')).map((tokens, index) => {
    const number = index + 1;
    const step = steps.find((candidate) => candidate.range && inRange(number, candidate.range));
    return { number, tokens, own: inRange(number, source.range), step: step?.id ?? null };
  });
}

/** Whether the file holds more than the run's automation: a `factory.yml` with others in it. */
export function holdsOthers(source: Pick<RunSource, 'text' | 'range'>): boolean {
  const count = source.text.replace(/\n+$/, '').split('\n').length;
  return source.range.start > 1 || source.range.end < count;
}

/** A step's lines, as a link to them says: `line 12`, `lines 12–20`. */
export function rangeWords(range: LineRange): string {
  return range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`;
}

/** The version a run executed, against the factory's latest: `v3 · latest`, `v3 · latest is v5`. */
export function fileVersionWords(version: number, latest: number): string {
  return latest > version ? `v${version} · latest is v${latest}` : `v${version} · latest`;
}

const MODE_WORDS: Record<RunSource['mode'], string> = {
  auto: 'Runs on its own',
  confirm: 'Asks before every run',
  notify: 'Says what it would do, and starts nothing',
};

/** What an automation does when it fires, as the desktop words its mode. */
export function modeWords(mode: string): string {
  return Object.hasOwn(MODE_WORDS, mode) ? MODE_WORDS[mode as RunSource['mode']] : mode;
}

const TRIGGER_WORDS: Record<RunSource['trigger']['kind'], string> = {
  cron: 'On a schedule',
  event: 'On an event',
  poll: 'On a poll',
  manual: 'When someone runs it',
};

/** How an automation is started, as its definition says it. */
export function triggerDefinitionWords(kind: string): string {
  return Object.hasOwn(TRIGGER_WORDS, kind)
    ? TRIGGER_WORDS[kind as RunSource['trigger']['kind']]
    : kind;
}

/** What an automation runs on: `Pull requests`, `Issues`, both, or no item at all. */
export function appliesToWords(kinds: readonly string[]): string {
  const pr = kinds.includes('pr');
  const issue = kinds.includes('issue');
  if (pr && issue) return 'Pull requests and issues';
  if (pr) return 'Pull requests';
  if (issue) return 'Issues';
  return 'No pull request or issue';
}
