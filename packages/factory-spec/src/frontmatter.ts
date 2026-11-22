import { isMap, isPair, isScalar, LineCounter, parseDocument } from 'yaml';
import { documentValue } from './yamlValue';

/**
 * A Markdown file's YAML frontmatter, split from its body. Internal: agent
 * files and a skill's `SKILL.md` share it.
 *
 * The opening and closing lines are exactly `---` (a `\r` before the line
 * break is accepted, so a file saved on Windows reads the same), and a
 * leading byte-order mark is dropped. A file whose first line is anything
 * else has no frontmatter: it is all body.
 */
export type SplitFrontmatter =
  | { kind: 'none'; body: string }
  | { kind: 'unclosed' }
  | {
      kind: 'ok';
      /** The text between the two `---` lines, their line breaks included. */
      yaml: string;
      /** The 1-based file line the YAML starts on. */
      firstLine: number;
      /** Everything after the closing line's line break, byte for byte. */
      body: string;
      /** The 1-based file line the body starts on. */
      bodyLine: number;
    };

const isFence = (line: string) => line === '---' || line === '---\r';

export function splitFrontmatter(text: string): SplitFrontmatter {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const firstBreak = source.indexOf('\n');
  const firstLine = firstBreak === -1 ? source : source.slice(0, firstBreak);
  if (!isFence(firstLine)) return { kind: 'none', body: source };
  if (firstBreak === -1) return { kind: 'unclosed' };

  let start = firstBreak + 1;
  let line = 2;
  while (start <= source.length) {
    const end = source.indexOf('\n', start);
    const current = end === -1 ? source.slice(start) : source.slice(start, end);
    if (isFence(current)) {
      return {
        kind: 'ok',
        yaml: source.slice(firstBreak + 1, start),
        firstLine: 2,
        body: end === -1 ? '' : source.slice(end + 1),
        bodyLine: line + 1,
      };
    }
    if (end === -1) break;
    start = end + 1;
    line += 1;
  }
  return { kind: 'unclosed' };
}

/** The frontmatter's YAML, read: its value, and the file line of each top-level key. */
export type ReadFrontmatter =
  | { ok: false; errors: Array<{ message: string; line: number }> }
  | { ok: true; value: unknown; lineOf(key: string): number | undefined };

export function readFrontmatter(yaml: string, firstLine: number): ReadFrontmatter {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter, prettyErrors: false });
  const fileLine = (offset: number | undefined) =>
    offset === undefined ? undefined : firstLine - 1 + lineCounter.linePos(offset).line;
  if (doc.errors.length > 0) {
    return {
      ok: false,
      errors: doc.errors.map((error) => ({
        message: error.message.split('\n')[0].trim(),
        line:
          (error.linePos?.[0]?.line !== undefined
            ? firstLine - 1 + error.linePos[0].line
            : fileLine(error.pos?.[0])) ?? firstLine,
      })),
    };
  }
  const lineOf = (key: string): number | undefined => {
    if (!isMap(doc.contents)) return undefined;
    const pair = doc.contents.items.find(
      (item) => isPair(item) && isScalar(item.key) && item.key.value === key,
    );
    const range = pair && isScalar(pair.key) ? pair.key.range : undefined;
    return fileLine(range?.[0]);
  };
  const value = documentValue(doc);
  if (!value.ok) return { ok: false, errors: [{ message: value.message, line: firstLine }] };
  return { ok: true, value: value.value, lineOf };
}
