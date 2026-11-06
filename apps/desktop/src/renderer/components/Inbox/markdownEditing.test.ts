import { describe, expect, it } from 'vitest';
import { applyFormat, insertSuggestion, insertText } from './markdownEditing';

const at = (value: string, start: number, end = start) => ({ value, start, end });
const format = (input: ReturnType<typeof at>, kind: Parameters<typeof applyFormat>[3]) => applyFormat(input.value, input.start, input.end, kind);

describe('markdown toolbar', () => {
  it('wraps the selection, selecting what was wrapped', () => {
    expect(format(at('make it bold', 8, 12), 'bold')).toEqual({ value: 'make it **bold**', selectionStart: 10, selectionEnd: 14 });
    expect(format(at('x', 1), 'italic')).toEqual({ value: 'x__', selectionStart: 2, selectionEnd: 2 });
    expect(format(at('call run()', 5, 10), 'code').value).toBe('call `run()`');
  });

  it('fences code that spans lines', () => {
    expect(format(at('a\nb', 0, 3), 'code').value).toBe('```\na\nb\n```\n');
  });

  it('makes a link with the URL ready to type over', () => {
    const edit = format(at('see docs', 4, 8), 'link');
    expect(edit.value).toBe('see [docs](url)');
    expect(edit.value.slice(edit.selectionStart, edit.selectionEnd)).toBe('url');
  });

  it('prefixes every line the selection touches', () => {
    expect(format(at('one\ntwo', 1, 5), 'numbered').value).toBe('1. one\n2. two');
    expect(format(at('one\ntwo', 0, 7), 'task').value).toBe('- [ ] one\n- [ ] two');
    expect(format(at('title', 2), 'heading')).toEqual({ value: '### title', selectionStart: 9, selectionEnd: 9 });
    expect(format(at('para\nquote me', 7), 'quote').value).toBe('para\n\n> quote me');
  });

  it('inserts a suggestion on lines of its own', () => {
    expect(insertSuggestion('Try:', 4, 4, 'const a = 1;').value).toBe('Try:\n```suggestion\nconst a = 1;\n```\n');
  });

  it('inserts a quote after what is already written, leaving a blank line', () => {
    expect(insertText('Hi', 2, 2, '> quoted\n\n')).toEqual({ value: 'Hi\n\n> quoted\n\n', selectionStart: 14, selectionEnd: 14 });
    expect(insertText('', 0, 0, '> q\n\n').value).toBe('> q\n\n');
  });
});
