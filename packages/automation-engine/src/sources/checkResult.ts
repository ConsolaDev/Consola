import {
  parseFieldPath,
  readFieldPath,
  type FieldPath,
  type PollTrigger,
} from '@consola/factory-spec';
import type { WorkItemPort } from '../ports';
import { clipText } from '../steps/commandIO';
import { fallbackWorkItemTitle } from '../support';
import type { ItemRef } from '../views';

export const MAX_CHECK_STDOUT_BYTES = 1024 * 1024;
export const MAX_CHECK_ITEMS = 500;
export const MAX_CHECK_ITEM_BYTES = 64 * 1024;
export const TITLE_CHARS = 80;

/** One item a check returned. `object` is the item exactly as printed. */
export interface PolledItem {
  key: string;
  rev?: string;
  title: string;
  url: string;
  workItem?: ItemRef;
  object: Record<string, unknown>;
}

type Result = { ok: true; items: PolledItem[] } | { ok: false; problem: string };

const fail = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });
const echo = (text: string) => clipText(text, 120);
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'object':
      return 'an object';
    case 'number':
      return 'a number';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    default:
      return typeof value;
  }
}

function cutTitle(title: string): string {
  const characters = Array.from(title);
  return characters.length > TITLE_CHARS
    ? `${characters.slice(0, TITLE_CHARS - 1).join('')}…`
    : title;
}

function parsePath(text: string | undefined): FieldPath | null {
  if (text === undefined) return null;
  const parsed = parseFieldPath(text);
  return parsed.ok ? parsed.path : null;
}

/** Turns a check's stdout into items, or says exactly why it cannot. Problems name the first failing item. */
export function readCheckResult(input: {
  stdout: string;
  truncated: boolean;
  trigger: PollTrigger;
  workItems: Pick<WorkItemPort, 'parseUrl' | 'keyOf' | 'urlOf'>;
}): Result {
  const { trigger, workItems } = input;
  if (input.truncated) return fail('Its stdout is over 1 MB.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout);
  } catch (error) {
    return fail(
      `Its stdout is not JSON (${echo(error instanceof Error ? error.message : String(error))}).`,
    );
  }
  if (!Array.isArray(parsed)) {
    const kind =
      parsed !== null && typeof parsed === 'object' ? 'a JSON object' : `JSON ${kindOf(parsed)}`;
    return fail(`Its stdout is ${kind}, not an array of objects.`);
  }
  if (parsed.length > MAX_CHECK_ITEMS) {
    return fail(`It returned ${parsed.length} items; a check returns at most ${MAX_CHECK_ITEMS}.`);
  }

  const keyPath = parsePath(trigger.key);
  const itemPath = parsePath(trigger.item?.path);
  const changedPath = parsePath(trigger.changed);
  if (trigger.key !== undefined && !keyPath)
    return fail(`Its key path ${echo(trigger.key)} is not a field path.`);
  if (trigger.item && !itemPath)
    return fail(`Its item path ${echo(trigger.item.path)} is not a field path.`);
  if (trigger.changed !== undefined && !changedPath)
    return fail(`Its changed path ${echo(trigger.changed)} is not a field path.`);
  if (!keyPath && !itemPath) return fail('It names neither a key nor an item.');

  const items: PolledItem[] = [];
  const keyIndex = new Map<string, number>();
  const workItemIndex = new Map<string, number>();

  for (let index = 0; index < parsed.length; index++) {
    const raw: unknown = parsed[index];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(`Item ${index} is ${kindOf(raw)}, not an object.`);
    }
    const object = raw as Record<string, unknown>;
    if (utf8Bytes(JSON.stringify(object)) > MAX_CHECK_ITEM_BYTES)
      return fail(`Item ${index} is over 64 KB.`);

    let key: string;
    let url = '';
    let workItem: ItemRef | undefined;
    if (itemPath && trigger.item) {
      const found = readFieldPath(object, itemPath);
      if (!found.found) return fail(`Item ${index} has no \`${trigger.item.path}\`.`);
      const text = typeof found.value === 'string' ? found.value : '';
      const ref = text ? workItems.parseUrl(trigger.item.connection, text) : null;
      if (!ref) {
        const shown = typeof found.value === 'string' ? found.value : JSON.stringify(found.value);
        return fail(
          `Item ${index}'s \`${trigger.item.path}\` is not a ${trigger.item.connection} work item URL: "${echo(shown ?? String(found.value))}".`,
        );
      }
      key = workItems.keyOf(ref);
      url = workItems.urlOf(ref);
      workItem = ref;
      const earlier = workItemIndex.get(key);
      if (earlier !== undefined) {
        const name = ref as unknown as { repo: string; number: number };
        return fail(
          `Items ${earlier} and ${index} name the same work item (${name.repo}#${name.number}).`,
        );
      }
      workItemIndex.set(key, index);
    } else if (keyPath && trigger.key !== undefined) {
      const found = readFieldPath(object, keyPath);
      if (!found.found) return fail(`Item ${index} has no key at \`${trigger.key}\`.`);
      const value = found.value;
      if (typeof value === 'string' && value !== '') key = value;
      else if (typeof value === 'number' && Number.isFinite(value)) key = String(value);
      else return fail(`Item ${index}'s key at \`${trigger.key}\` is not text or a number.`);
      const earlier = keyIndex.get(key);
      if (earlier !== undefined)
        return fail(`Items ${earlier} and ${index} have the same key "${echo(key)}".`);
      keyIndex.set(key, index);
    } else {
      return fail('It names neither a key nor an item.');
    }

    let rev: string | undefined;
    if (changedPath && trigger.changed !== undefined) {
      const found = readFieldPath(object, changedPath);
      const value = found.found ? found.value : null;
      if (value === null || value === undefined) rev = '';
      else if (typeof value === 'string') rev = value;
      else if (typeof value === 'number' || typeof value === 'boolean') rev = String(value);
      else
        return fail(
          `Item ${index}'s \`${trigger.changed}\` is ${kindOf(value)}; \`changed:\` needs text, a number, true or false.`,
        );
    }

    const title =
      typeof object.title === 'string' && object.title !== ''
        ? cutTitle(object.title)
        : workItem
          ? fallbackWorkItemTitle(workItem)
          : cutTitle(key);
    const polled: PolledItem = { key, title, url, object };
    if (rev !== undefined) polled.rev = rev;
    if (workItem) polled.workItem = workItem;
    items.push(polled);
  }
  return { ok: true, items };
}
