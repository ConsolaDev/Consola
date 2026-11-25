import { type ItemSource, resolveWebhookTrigger } from '@consola/automation-engine/core';
import {
  type Automation,
  type FactoryParseResult,
  isRunOwnedCheckout,
  isStepsEntry,
  parseFactory,
  type StepsAutomation,
  storedFactoryFiles,
} from '@consola/factory-spec';
import type { FactorySnapshot, PullRequestFacts } from '@consola/runner-protocol';

/**
 * Which automations a GitHub event starts: each factory the cell sent, parsed by factory-spec as
 * the cell and the desktop parse it, and each entry whose trigger is GitHub's and lists the
 * event (`pull_request.<action>`), read by the engine's `resolveWebhookTrigger`: the events only
 * GitHub's webhooks say, the entry's `filter:` by the Inbox's rules. Pure.
 *
 * Anything this runner cannot honour exactly matches nothing and says why in a note for the
 * runner's log, never in a run: a factory with problems (all of it, as a folder that does not
 * apply cleanly runs nothing new on the desktop), an entry the engine refuses for a webhook (an
 * Inbox event beside this one, parameters, a filter it cannot read), a `run:` entry, and a
 * checkout of the run's own (`checkout: { repo, branch }`).
 */

/** An automation the event starts. */
export type Match = {
  readonly factory: { readonly id: string; readonly version: number };
  readonly automation: StepsAutomation;
  /** Its factory as parsed: the agents its steps name. */
  readonly parsed: FactoryParseResult;
  /** `pull_request.opened`. */
  readonly event: string;
  /** The connection's item source: its steps' header, fence and fields. */
  readonly source: ItemSource;
};

/** `pull_request.<action>`, the name an entry's `on:` lists. */
export const eventNameOf = (event: PullRequestFacts): string => `${event.name}.${event.action}`;

/** A factory's parse, with the file set it was read from, as the cell stores it. */
export function parseSnapshot(snapshot: FactorySnapshot): FactoryParseResult {
  return parseFactory(storedFactoryFiles(snapshot.files));
}

/** Why an entry the event names does not run here, though the engine reads its trigger; null when it does. */
function refusalOf(automation: Automation): string | null {
  if (!isStepsEntry(automation)) {
    return 'it is a `run:` entry, which runs on the desktop only; a cloud runner runs `steps:`';
  }
  if (isRunOwnedCheckout(automation.checkout)) {
    return 'a checkout of its own (`checkout: { repo, branch }`) does not run on a cloud runner yet';
  }
  return null;
}

export function matchEvent(
  factories: readonly FactorySnapshot[],
  event: PullRequestFacts,
): { readonly matches: readonly Match[]; readonly notes: readonly string[] } {
  const name = eventNameOf(event);
  const matches: Match[] = [];
  const notes: string[] = [];
  for (const snapshot of factories) {
    const factory = { id: snapshot.factoryId, version: snapshot.version };
    const where = `factory ${factory.id} v${factory.version}`;
    const parsed = parseSnapshot(snapshot);
    if (parsed.issues.length > 0) {
      const count = parsed.issues.length;
      notes.push(
        `${where} has ${count} ${count === 1 ? 'problem' : 'problems'} in its files, so none of its automations runs for ${name}`,
      );
      continue;
    }
    for (const automation of parsed.automations) {
      const { trigger } = automation;
      if (trigger.kind !== 'event' || trigger.connection !== 'github') continue;
      if (!trigger.events.includes(name)) continue;
      const resolved = resolveWebhookTrigger(trigger, automation.filter);
      if (!resolved.ok) {
        notes.push(`${where}: ${automation.name} does not run for ${name}: ${resolved.problem}`);
        continue;
      }
      const refused = refusalOf(automation);
      if (refused !== null || !isStepsEntry(automation)) {
        notes.push(`${where}: ${automation.name} does not run for ${name}: ${refused}`);
        continue;
      }
      if (!resolved.passes({ repo: event.repository, author: event.author, draft: event.draft })) {
        continue;
      }
      matches.push({
        factory,
        automation,
        parsed,
        event: name,
        source: resolved.source,
      });
    }
  }
  return { matches, notes };
}
