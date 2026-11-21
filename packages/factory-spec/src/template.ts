/**
 * `{{ path }}` templates: where a prompt or an `env:` value names something
 * a run knows. Parsing is separate from rendering so validation can check a
 * template without a run, and the runner renders it with values in hand.
 */

export type TemplatePath =
  | { root: 'item'; field: string; text: string }
  | { root: 'steps'; step: string; name: string; file: boolean; text: string };

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'path'; path: TemplatePath };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** `{{` anywhere: a command containing it is refused, since values reach commands only as environment. */
export function hasTemplateBraces(text: string): boolean {
  return text.includes('{{');
}

const NOT_A_PATH = (inner: string) =>
  `\`{{${inner}}}\` is not a path; item fields are \`{{item.title}}\``;

function parsePath(
  inner: string,
): { ok: true; path: TemplatePath } | { ok: false; problem: string } {
  const segments = inner.split('.');
  const root = segments[0];
  if (root === 'previous') {
    return {
      ok: false,
      problem: '`previous` (what the last run on this item wrote) is not supported yet.',
    };
  }
  if (root === 'item') {
    if (segments.length === 2 && IDENT.test(segments[1])) {
      return { ok: true, path: { root: 'item', field: segments[1], text: inner } };
    }
    if (segments.length === 3 && IDENT.test(segments[1]) && segments[2] === 'file') {
      return {
        ok: false,
        problem: `\`.file\` names an artifact's file; \`item.${segments[1]}\` is not an artifact`,
      };
    }
    return { ok: false, problem: NOT_A_PATH(inner) };
  }
  if (root === 'steps') {
    const [, step, name, last] = segments;
    const shape =
      (segments.length === 3 || (segments.length === 4 && last === 'file')) &&
      STEP_ID.test(step) &&
      IDENT.test(name);
    if (!shape) {
      return {
        ok: false,
        problem: `\`{{${inner}}}\` is not a path; use \`steps.<step>.<output or artifact>\`, optionally followed by \`.file\``,
      };
    }
    return {
      ok: true,
      path: { root: 'steps', step, name, file: segments.length === 4, text: inner },
    };
  }
  return { ok: false, problem: NOT_A_PATH(inner) };
}

/** Splits text into literal text and paths, left to right. */
export function parseTemplate(
  text: string,
): { ok: true; parts: TemplatePart[] } | { ok: false; problem: string } {
  const parts: TemplatePart[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf('{{', from);
    if (open === -1) break;
    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      return { ok: false, problem: `unclosed \`{{\` in \`${text.slice(open)}\`` };
    }
    if (open > from) parts.push({ kind: 'text', text: text.slice(from, open) });
    const parsed = parsePath(text.slice(open + 2, close).trim());
    if (!parsed.ok) return parsed;
    parts.push({ kind: 'path', path: parsed.path });
    from = close + 2;
  }
  if (from < text.length) parts.push({ kind: 'text', text: text.slice(from) });
  return { ok: true, parts };
}

/** Fills the paths in. The first path with no value is reported, not guessed. */
export function renderTemplate(
  parts: TemplatePart[],
  value: (path: TemplatePath) => string | undefined,
): { ok: true; text: string } | { ok: false; missing: TemplatePath } {
  let out = '';
  for (const part of parts) {
    if (part.kind === 'text') {
      out += part.text;
      continue;
    }
    const resolved = value(part.path);
    if (resolved === undefined) return { ok: false, missing: part.path };
    out += resolved;
  }
  return { ok: true, text: out };
}

/** Every path in `text`; empty when it does not parse (validation reports why). */
export function templatePaths(text: string): TemplatePath[] {
  const result = parseTemplate(text);
  if (!result.ok) return [];
  const paths: TemplatePath[] = [];
  for (const part of result.parts) if (part.kind === 'path') paths.push(part.path);
  return paths;
}
