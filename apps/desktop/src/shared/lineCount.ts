/**
 * Lines in `text`, counted the way git counts them in a diff: a final newline
 * ends the last line rather than starting another, and an empty file has none.
 * `text.split('\n').length` is one too many for every file that ends in a
 * newline, which is nearly all of them.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  let newlines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) newlines++;
  return text.endsWith('\n') ? newlines : newlines + 1;
}
