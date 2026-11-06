/**
 * The comment toolbar's edits, as GitHub's own toolbar makes them: wrap the
 * selection, or insert at the caret with the caret left where typing goes
 * next. Pure, so each is tested once here.
 */
export type MarkdownFormat = 'heading' | 'bold' | 'italic' | 'quote' | 'code' | 'link' | 'numbered' | 'bulleted' | 'task';

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function wrap(value: string, start: number, end: number, before: string, after: string, placeholder = ''): TextEdit {
  const selected = value.slice(start, end) || placeholder;
  return {
    value: value.slice(0, start) + before + selected + after + value.slice(end),
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length,
  };
}

/** Every line the selection touches gets a prefix; `numbered` counts them. */
function prefixLines(value: string, start: number, end: number, prefix: (index: number) => string): TextEdit {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = end > start && value[end - 1] === '\n' ? end - 1 : nextBreak < 0 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const prefixed = lines.map((line, index) => prefix(index) + line).join('\n');
  // A list or quote begun mid-paragraph needs a blank line before it to be one.
  const gap = lineStart > 0 && value[lineStart - 2] !== undefined && value[lineStart - 2] !== '\n' ? '\n' : '';
  const next = value.slice(0, lineStart) + gap + prefixed + value.slice(lineEnd);
  const caret = lineStart + gap.length + prefixed.length;
  return start === end
    ? { value: next, selectionStart: caret, selectionEnd: caret }
    : { value: next, selectionStart: lineStart + gap.length, selectionEnd: caret };
}

export function applyFormat(value: string, start: number, end: number, format: MarkdownFormat): TextEdit {
  const selected = value.slice(start, end);
  switch (format) {
    case 'bold':
      return wrap(value, start, end, '**', '**');
    case 'italic':
      return wrap(value, start, end, '_', '_');
    case 'code':
      return selected.includes('\n')
        ? wrap(value, start, end, `${start > 0 && value[start - 1] !== '\n' ? '\n' : ''}\`\`\`\n`, '\n```\n')
        : wrap(value, start, end, '`', '`');
    case 'link': {
      // The text stays as it is; the URL placeholder is what gets selected to type over.
      const before = `${value.slice(0, start)}[${selected}](`;
      return { value: `${before}url)${value.slice(end)}`, selectionStart: before.length, selectionEnd: before.length + 3 };
    }
    case 'heading':
      return prefixLines(value, start, end, () => '### ');
    case 'quote':
      return prefixLines(value, start, end, () => '> ');
    case 'bulleted':
      return prefixLines(value, start, end, () => '- ');
    case 'numbered':
      return prefixLines(value, start, end, (index) => `${index + 1}. `);
    case 'task':
      return prefixLines(value, start, end, () => '- [ ] ');
  }
}

/** A ```suggestion block holding `lines`, inserted at the caret on lines of its own. */
export function insertSuggestion(value: string, start: number, end: number, lines: string): TextEdit {
  const before = `${start > 0 && value[start - 1] !== '\n' ? '\n' : ''}\`\`\`suggestion\n`;
  return wrap(value, start, end, before, '\n```\n', lines);
}

/** Text inserted at the caret (a quote reply), with the caret after it. */
export function insertText(value: string, start: number, end: number, text: string): TextEdit {
  const lead = start > 0 && !value.slice(0, start).endsWith('\n\n') ? (value.slice(0, start).endsWith('\n') ? '\n' : '\n\n') : '';
  const next = value.slice(0, start) + lead + text + value.slice(end);
  const caret = start + lead.length + text.length;
  return { value: next, selectionStart: caret, selectionEnd: caret };
}
