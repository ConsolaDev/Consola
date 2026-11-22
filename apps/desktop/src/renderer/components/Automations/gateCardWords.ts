import type { GateView } from '../../../shared/automations';
import { formatAgo } from './presentation';

/**
 * The words of a gate's card on the run page (slice 3, *UI › The run
 * page*): its question, the label of each choice, the line that says a newer
 * revision of the item is held, and how it was answered. Main fills the
 * question in from the run's trusted values and lists the choices the run's
 * own definition offers; the card only words them.
 */

/** The card's heading: the question, and for a loop's exhaustion gate how many rounds it ran. */
export function gateHeading(view: Pick<GateView, 'ask' | 'loop'>): string {
  return view.loop ? `${view.ask} (after ${view.loop.rounds} rounds)` : view.ask;
}

/** A choice as its button says it: `approve` → `Approve`, `request-changes` → `Request changes`. */
export function gateChoiceLabel(choice: string): string {
  const words = choice.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why the person may want to look again before answering: a newer revision of the item waits for this run to end. */
export function newerRevisionLine(view: Pick<GateView, 'newerRevision'>): string | null {
  if (view.newerRevision === 'pull-request')
    return 'This pull request has new commits since the review (held until this run ends)';
  if (view.newerRevision === 'item') return 'This item has changed since this run read it';
  return null;
}

/** How the gate was answered, once it was: `answered comment by you 5m ago`. Null while it waits. */
export function answeredWords(view: Pick<GateView, 'answered'>, now: Date): string | null {
  const { answered } = view;
  if (!answered) return null;
  return `answered ${answered.decision} by you ${formatAgo(answered.at, now)}`;
}
