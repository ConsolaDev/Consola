/**
 * YAML as tokens, for shading a factory's file as it is written: the desktop's tokenizer
 * (`Automations/presentation.ts`, `yamlTokens`), line for line. Shading only: nothing here decides
 * what the file means, and every token's text is the file's own, so a line's tokens joined give
 * the line back. A block scalar's body (`prompt: |`) is text however it looks, so it is never
 * read as keys.
 */

/** A piece of one line of YAML, by what it is. */
export type YamlToken = {
  kind:
    | 'space'
    | 'dash'
    | 'key'
    | 'colon'
    | 'punct'
    | 'string'
    | 'number'
    | 'literal'
    | 'plain'
    | 'comment';
  text: string;
};

/** An inline map or list's pieces: a quoted string, a key, a number, punctuation, space, or a bare word. */
const YAML_FLOW =
  /("[^"]*"|'[^']*')|([^\s{}[\],:"']+)(?=\s*:)|(-?\d+(?:\.\d+)?)(?=[\s,}\]]|$)|([{}[\],])|(:)|(\s+)|([^\s{}[\],:"']+|.)/g;

/** `{ cron: "0 9 * * *" }` and `[merged, closed]`, shaded inside as a block mapping is. */
function flowTokens(value: string): YamlToken[] {
  const tokens: YamlToken[] = [];
  for (const [text, string, key, number, punct, colon, space] of value.matchAll(YAML_FLOW)) {
    const kind: YamlToken['kind'] = string
      ? 'string'
      : key
        ? 'key'
        : number
          ? 'number'
          : punct
            ? 'punct'
            : colon
              ? 'colon'
              : space
                ? 'space'
                : /^(true|false|null|~)$/i.test(text)
                  ? 'literal'
                  : 'plain';
    tokens.push({ kind, text });
  }
  return tokens;
}

const YAML_KEY = /^((?:"[^"]*"|'[^']*'|[^\s#'"][^:#]*?))(:)(?=\s|$)/;

/** A file's lines as tokens, one array per line. */
export function yamlTokens(text: string): YamlToken[][] {
  let blockIndent: number | null = null;
  return text.split('\n').map((line) => {
    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const tokens: YamlToken[] = indent > 0 ? [{ kind: 'space', text: line.slice(0, indent) }] : [];
    if (blockIndent !== null) {
      if (body === '' || indent > blockIndent) {
        if (body) tokens.push({ kind: 'string', text: body });
        return tokens;
      }
      blockIndent = null;
    }
    let rest = body;
    let column = indent;
    while (rest.startsWith('- ') || rest === '-') {
      tokens.push({ kind: 'dash', text: '-' });
      if (rest.length > 1) tokens.push({ kind: 'space', text: ' ' });
      rest = rest.slice(2);
      column += 2;
    }
    if (rest.startsWith('#')) return [...tokens, { kind: 'comment', text: rest }];
    const key = YAML_KEY.exec(rest);
    if (key) {
      tokens.push({ kind: 'key', text: key[1] }, { kind: 'colon', text: ':' });
      rest = rest.slice(key[0].length);
      if (/^\s*[|>][-+0-9]*\s*(#.*)?$/.test(rest)) blockIndent = column;
    }
    if (rest) tokens.push(...valueTokens(rest));
    return tokens;
  });
}

function valueTokens(rest: string): YamlToken[] {
  const lead = rest.length - rest.trimStart().length;
  const tokens: YamlToken[] = lead > 0 ? [{ kind: 'space', text: rest.slice(0, lead) }] : [];
  let value = rest.slice(lead);
  let comment = '';
  if (!/^["']/.test(value)) {
    const hash = value.search(/\s#/);
    if (hash !== -1) {
      comment = value.slice(hash);
      value = value.slice(0, hash);
    }
  }
  if (/^[{[]/.test(value)) tokens.push(...flowTokens(value));
  else if (value) {
    const kind: YamlToken['kind'] = /^(["']).*\1$/.test(value)
      ? 'string'
      : /^-?\d+(\.\d+)?$/.test(value)
        ? 'number'
        : /^(true|false|null|~|[|>][-+0-9]*)$/i.test(value)
          ? 'literal'
          : 'plain';
    tokens.push({ kind, text: value });
  }
  if (comment) {
    const space = comment.length - comment.trimStart().length;
    tokens.push(
      { kind: 'space', text: comment.slice(0, space) },
      { kind: 'comment', text: comment.slice(space) },
    );
  }
  return tokens;
}
