import type { ExprValue, PollTrigger, RunItem } from '@consola/factory-spec';
import { describeEvery } from '../describeEntry';
import { fallbackWorkItemTitle, fillActionPlaceholders } from '../support';
import type { PolledItem } from './checkResult';
import {
  fenceUntrusted,
  MAX_FENCED_CHARS,
  MAX_FENCED_FIELDS,
  POLL_FENCE_HEADING,
  READ_ONLY_NOTE,
  UNWATCHED_NOTE,
  type ItemSource,
  type SourceItem,
} from './itemSource';

/*
 * A poll's item source. Its items are the objects its check command printed:
 * every top-level string, number or boolean is a field, and every one is
 * untrusted. With `item:`, Consola sets the work item's identity from the URL
 * it parsed (`key`, `url`, `repo`, `number`, `type`): those replace the
 * object's fields of the same names, and are trusted. Without it, `item.key`
 * is the poll key and nothing is trusted.
 */

/** What `item:` makes trusted: the work item's identity, as parsed from its URL. */
const IDENTITY = new Set(['key', 'url', 'repo', 'number', 'type']);

/** A name `item.<field>` can spell (a field path's): no other key is a field, so none reaches the fence unquoted. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `fenceUntrusted` says "<provenance> were written by other people.": a poll's
 * provenance is its heading up to there. Read when a fence is made, never when
 * this module loads: `itemSource` imports this module, so its constants may
 * not be there yet.
 */
const pollProvenance = (): string =>
  POLL_FENCE_HEADING.replace(/ were written by other people\.$/, '');

const own = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

function isScalar(value: unknown): value is ExprValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The object's top-level scalar of that name, read as its own property only. */
function scalarOf(
  object: Record<string, unknown> | undefined,
  field: string,
): ExprValue | undefined {
  if (!object || !FIELD_NAME.test(field) || !own(object, field)) return undefined;
  const value = object[field];
  return isScalar(value) ? value : undefined;
}

/** Whether a run item names a work item: the identity `item:` gave it. */
function hasWorkItem(item: RunItem): boolean {
  return item.repo !== undefined && item.number !== undefined && item.type !== undefined;
}

function cut(text: string): string {
  const characters = Array.from(text);
  return characters.length > MAX_FENCED_CHARS
    ? characters.slice(0, MAX_FENCED_CHARS).join('')
    : text;
}

/**
 * One item a check returned, as firing, a queued run's check and its start
 * pass it around: its key, revision, identity and object as printed.
 * `passes` is whether it may fire (an item of `item:` whose repository the
 * workspace does not hold may not).
 */
export function polledSourceItem(polled: PolledItem, passes: boolean): SourceItem {
  return {
    key: polled.key,
    ...(polled.rev !== undefined ? { rev: polled.rev } : {}),
    passes,
    title: polled.title,
    url: polled.url,
    ...(polled.workItem ? { workItem: polled.workItem } : {}),
    object: polled.object,
  };
}

export function pollSource(trigger: PollTrigger, workItemPart?: ItemSource): ItemSource {
  // A poll with `key:` has no work items; one with `item:` has them only through a connection that reads URLs.
  const part = trigger.item ? workItemPart : undefined;
  const identityOf = (item: RunItem): boolean => part !== undefined && hasWorkItem(item);

  const fenceItem = (item: RunItem, polled?: Record<string, unknown>): string => {
    const trusted = identityOf(item);
    const fields: Record<string, string> = {};
    let count = 0;
    for (const [name, value] of Object.entries(polled ?? {})) {
      if (count === MAX_FENCED_FIELDS) break;
      if (!FIELD_NAME.test(name) || !isScalar(value) || (trusted && IDENTITY.has(name))) continue;
      fields[name] = cut(String(value));
      count++;
    }
    return fenceUntrusted(fields, pollProvenance());
  };

  const runItem = (item: SourceItem): RunItem =>
    part && item.workItem
      ? part.runItem(item)
      : { key: item.key, url: item.url, title: item.title };

  const describeItemHeader = (item: RunItem): string =>
    part && hasWorkItem(item) ? part.describeItemHeader(item) : 'the item described below';

  return {
    ...(trigger.item ? { connection: trigger.item.connection } : {}),
    itemTypes: trigger.item ? (part?.itemTypes ?? ['pr', 'issue']) : [],
    itemsHaveRepo: part?.itemsHaveRepo ?? false,
    describe: `Every ${describeEvery(trigger.everyMs).words}, checks with a command`,
    goneReason: 'It is no longer in what its check returns.',
    label: (item) => (part && item.workItem ? part.label(item) : `“${item.title}”`),
    runItem,
    describeItemHeader,
    fenceItem,
    itemValue(item, field, polled) {
      // With `item:`, identity is trusted in prompts: it comes from the URL Consola parsed, or not at all, never from the object.
      if (trigger.item && IDENTITY.has(field)) {
        return identityOf(item)
          ? (item as unknown as Record<string, ExprValue | undefined>)[field]
          : undefined;
      }
      if (!trigger.item && field === 'key') return item.key;
      return scalarOf(polled, field);
    },
    renderPrompt(body, item, automation) {
      const recorded = runItem(item);
      const fence = fenceItem(recorded, item.object);
      if (!part || !item.workItem) {
        // Nothing names the item but what the check printed: the header points at the fence.
        const header = `This session was started by the automation "${automation}" for the item described below. ${READ_ONLY_NOTE} ${UNWATCHED_NOTE}`;
        return `${header}\n\n${body.trim()}\n\n${fence}`;
      }
      const noun = item.workItem.type === 'pr' ? 'pull request' : 'issue';
      const view = `Consola’s work_item_context tool, which returns the ${noun}’s description, comments${
        item.workItem.type === 'pr' ? ', files and diff' : ''
      }`;
      const where = part.itemsHaveRepo ? ', in a dedicated git worktree for it' : '';
      const header =
        `This session was started by the automation "${automation}" for ${describeItemHeader(recorded)}${where}. ` +
        `${READ_ONLY_NOTE} Start with ${view}. ${UNWATCHED_NOTE}`;
      // A title the check printed is the author's: the body points at it, the fence holds it. Without one, Consola's own words.
      const title =
        scalarOf(item.object, 'title') !== undefined
          ? 'the title quoted below'
          : fallbackWorkItemTitle(item.workItem);
      const job = fillActionPlaceholders(body, {
        workItem: item.workItem,
        title,
        url: recorded.url,
      }).trim();
      return `${header}\n\n${job}\n\n${fence}`;
    },
  };
}
