import type { Session } from './workspace';

type LabelSource = Pick<Session, 'workItem' | 'workItemAction' | 'name'>;

/**
 * A session's primary label — derived from the record, never from `name`.
 *
 * `workItemAction` is present only for a session this app launched from an
 * action (absent for one linked after the fact), which is exactly the
 * discriminator between "PR #4118 · Review" and "⑂ <name>". Deriving it here
 * means main's automatic naming, which can rewrite `name` (a stand-in, then a
 * generated title, or a CLI rename), never decides what a work-item row reads.
 */
export function sessionLabel(session: LabelSource): string {
  const name = readableName(session.name);
  if (!session.workItem) return name;
  if (session.workItemAction) {
    const kind = session.workItem.type === 'pr' ? 'PR' : 'Issue';
    return `${kind} #${session.workItem.number} · ${session.workItemAction}`;
  }
  return `⑂ ${name}`;
}

/**
 * A name as a person reads it. A name taken from a session's first message
 * can carry the CLI's own paste wrapper — `<pasted_content id="4d38">` — which
 * is markup, not words, and would otherwise be most of what a two-line row
 * shows. The tag goes; the pasted text it wraps stays. An opener the CLI cut
 * off mid-tag (no closing `>`) goes too.
 */
function readableName(name: string): string {
  if (!name.includes('pasted_content')) return name;
  return name
    .replace(/<\/?pasted_content\b[^>]*(?:>|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
