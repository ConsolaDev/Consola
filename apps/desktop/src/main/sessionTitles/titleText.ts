import { NEW_SESSION_NAME, type Session } from '../../shared/workspace';

/** Longest stand-in shown while a session waits for its generated title. */
export const STAND_IN_MAX = 50;
/** Longest title kept, generated or adopted from the CLI. */
export const TITLE_MAX = 120;
/** Longest first message sent to the title model. */
export const TITLE_INPUT_MAX = 8_000;

const ELLIPSIS = '…';

// Wrapping pairs stripped from a title, repeatedly, so `"'Name'"` also works.
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
];

/**
 * Returns text unchanged when it is at most `max` code points. Otherwise keeps
 * the first `keep` code points and ends with one ellipsis.
 */
function cutWithEllipsis(text: string, max: number, keep: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, keep).join('') + ELLIPSIS;
}

function isPlaceholder(name: string): boolean {
  return name.toLowerCase() === NEW_SESSION_NAME.toLowerCase();
}

/**
 * The name a session shows until its generated title arrives: the first
 * message, whitespace collapsed, cut to 50 code points.
 */
export function standInName(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return cutWithEllipsis(collapsed, STAND_IN_MAX, STAND_IN_MAX);
}

/**
 * Normalises a title from the model or the CLI. Returns null when nothing
 * usable is left, including the placeholder name.
 */
export function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let title = raw.trim().split(/\r?\n/)[0] ?? '';
  let stripped = true;
  while (stripped) {
    stripped = false;
    title = title.trim();
    for (const [open, close] of QUOTE_PAIRS) {
      if (
        title.length >= open.length + close.length &&
        title.startsWith(open) &&
        title.endsWith(close)
      ) {
        title = title.slice(open.length, title.length - close.length);
        stripped = true;
      }
    }
  }
  title = title.trim();

  if (title === '' || isPlaceholder(title)) return null;
  return cutWithEllipsis(title, TITLE_MAX, TITLE_MAX - 1);
}

/**
 * True while a session still waits for a generated name: it is not the
 * Assistant, the person has not named it, and it still carries the placeholder.
 */
export function isAwaitingName(session: Pick<Session, 'name' | 'nameIsUserSet' | 'kind'>): boolean {
  return session.kind !== 'assistant' && !session.nameIsUserSet && isPlaceholder(session.name);
}
