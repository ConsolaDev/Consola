import type { Session } from './workspace';

type LabelSource = Pick<Session, 'workItem' | 'workItemAction' | 'name'>;

/**
 * A session's primary label — derived from the record, never from `name`.
 *
 * `workItemAction` is present only for a session this app launched from an
 * action (absent for one linked after the fact), which is exactly the
 * discriminator between "PR #4118 · Review" and "⑂ <name>". Deriving it here
 * means the CLI-summary poll, which keeps rewriting `name`, no longer decides
 * what a work-item row reads; `name` survives as the subtitle.
 */
export function sessionLabel(session: LabelSource): string {
  if (!session.workItem) return session.name;
  if (session.workItemAction) {
    const kind = session.workItem.type === 'pr' ? 'PR' : 'Issue';
    return `${kind} #${session.workItem.number} · ${session.workItemAction}`;
  }
  return `⑂ ${session.name}`;
}

/** `name` as a subtitle or tooltip — only when the label above stopped showing it. */
export function sessionSubtitle(session: LabelSource): string | undefined {
  return session.workItem && session.workItemAction ? session.name : undefined;
}
