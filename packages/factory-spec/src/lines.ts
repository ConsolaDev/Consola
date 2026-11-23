import { parseAutomationFile } from './automationFile';
import type { LineRange } from './issues';
import { parseFactoryYml } from './parse';

export type { LineRange };

/** Where an automation is written in its file, and each of its steps. */
export interface AutomationLines {
  /** The automation's own lines: the whole file for `automations/<name>.yaml`. */
  range: LineRange;
  /**
   * Each step's lines, in the order the file writes them, which is the order the parsed
   * automation's `steps` hold them in; undefined for a step the file has no node for.
   */
  steps: Array<LineRange | undefined>;
}

/** How many lines `text` holds: a last line break ends a line, it starts none. */
function lineCount(text: string): number {
  if (text === '') return 1;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** The ranges of the items of the sequence at `path`, in order, while it has items. */
function itemRanges(
  rangeAt: (path: Array<string | number>) => LineRange | undefined,
  path: Array<string | number>,
): Array<LineRange | undefined> {
  const ranges: Array<LineRange | undefined> = [];
  for (let index = 0; ; index++) {
    const range = rangeAt([...path, index]);
    if (range === undefined) return ranges;
    ranges.push(range);
  }
}

/**
 * Where the automation `name` is written in `file`, a path inside the factory folder as an
 * automation's `file` names it (`factory.yml` or `automations/<name>.yaml`), whose text is
 * `text`: the automation's lines and each of its steps'. In `factory.yml` the automation is the
 * entry the folder's reader takes for that name (the one that loaded, else the first with it).
 * Undefined for any other file, a file whose YAML does not read, or an entry it does not hold.
 * It reads the text's shape only, never its rules: a file that parses with issues still has lines.
 */
export function automationLines(
  file: string,
  text: string,
  name: string,
): AutomationLines | undefined {
  if (file === 'factory.yml') {
    const read = parseFactoryYml(text);
    if (read.unreadable) return undefined;
    const entry = read.entryPath(name);
    const range = entry && read.rangeAt(entry);
    if (!entry || !range) return undefined;
    return { range, steps: itemRanges(read.rangeAt, [...entry, 'steps']) };
  }
  if (file !== `automations/${name}.yaml`) return undefined;
  const read = parseAutomationFile(name, text);
  if (read.unreadable) return undefined;
  return {
    range: { start: 1, end: lineCount(text) },
    steps: itemRanges(read.rangeAt, ['steps']),
  };
}
