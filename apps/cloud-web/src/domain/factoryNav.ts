import type { Factory } from './factories';
import { hashOfSection } from './sections';

/**
 * How the sidebar and the address name a factory. Each factory has pages of its own, listed
 * under it in the sidebar: its definition (its files) and its settings, at
 * `#/factories/<id>/<page>`. `#/factories` alone names no page of its own any more (there is no
 * list page): it lands on the first factory's definition, or the dashboard's first section when
 * there is none (`factoryLanding`).
 *
 * Which factories are unfolded in the sidebar is the person's convenience, kept per workspace
 * by `services/foldStore.ts`; the rules for it are here.
 */

/** What the address names where a section's id would be, for every factory page. */
export const FACTORIES_ID = 'factories';

/** A factory's pages, in the order the sidebar lists them; the first opens by default. */
export const FACTORY_PAGES = ['definition', 'settings'] as const;

export type FactoryPageId = (typeof FACTORY_PAGES)[number];

/** What a hash names in the factories' part of the address. */
export type FactoryRoute =
  /** `#/factories`: no factory named, so the page lands on one (`factoryLanding`). */
  { kind: 'landing' } | { kind: 'page'; factoryId: string; page: FactoryPageId };

const FACTORIES_HASH = /^#\/factories(?:\/([^/?]*))?(?:\/([^/?]*))?(?:[/?].*)?$/s;

function isFactoryPage(value: string | undefined): value is FactoryPageId {
  return (FACTORY_PAGES as ReadonlyArray<string | undefined>).includes(value);
}

/**
 * The factory page a hash names, `landing` for `#/factories` alone, or null for a hash outside
 * the factories. A factory with no page named, or one this build does not have, opens its first
 * page. An id that cannot be decoded lands as if none were named.
 */
export function factoryRouteOfHash(hash: string): FactoryRoute | null {
  const match = FACTORIES_HASH.exec(hash);
  if (!match) return null;
  const [, encoded, page] = match;
  if (!encoded) return { kind: 'landing' };
  let factoryId: string;
  try {
    factoryId = decodeURIComponent(encoded);
  } catch {
    return { kind: 'landing' };
  }
  return { kind: 'page', factoryId, page: isFactoryPage(page) ? page : FACTORY_PAGES[0] };
}

/** The hash that opens a factory's page, its first when none is named. */
export function hashOfFactoryPage(factoryId: string, page: FactoryPageId = FACTORY_PAGES[0]) {
  return `${hashOfSection(FACTORIES_ID)}/${encodeURIComponent(factoryId)}/${page}`;
}

/**
 * Where `#/factories` alone lands: the first factory's first page, as the cell lists them, or
 * null for none, which the page sends to the dashboard's first section.
 */
export function factoryLanding(factories: readonly Factory[]): string | null {
  const [first] = factories;
  return first ? hashOfFactoryPage(first.id) : null;
}

/**
 * Whether a factory's pages show under it in the sidebar: as the person left it, the factory
 * open included. Opening a factory unfolds it (`withFold`), and the person may fold it again.
 */
export function isUnfolded(factoryId: string, unfolded: readonly string[]): boolean {
  return unfolded.includes(factoryId);
}

/** The unfolded factories once `factoryId` is folded (`open` false) or unfolded. */
export function withFold(unfolded: readonly string[], factoryId: string, open: boolean): string[] {
  const others = unfolded.filter((id) => id !== factoryId);
  return open ? [...others, factoryId] : others;
}

/** The most unfolded factories kept, so the stored list cannot grow without end. */
const UNFOLDED_KEPT = 200;

/**
 * The unfolded factories as stored, read defensively: anything but a list of strings is none,
 * and only the most recent `UNFOLDED_KEPT` are kept.
 */
export function readUnfoldedText(text: string | null): string[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === 'string').slice(-UNFOLDED_KEPT);
  } catch {
    return [];
  }
}

/** The unfolded factories as they are stored. */
export function unfoldedText(unfolded: readonly string[]): string {
  return JSON.stringify(unfolded.slice(-UNFOLDED_KEPT));
}

/**
 * The colours a factory's tile can wear, Radix's scales that carry white text, picked by its id
 * (`factoryHue`), so a factory keeps its colour whatever it is renamed to.
 */
export const FACTORY_HUES = [
  'tomato',
  'orange',
  'grass',
  'teal',
  'cyan',
  'blue',
  'iris',
  'plum',
  'pink',
  'jade',
] as const;

export type FactoryHue = (typeof FACTORY_HUES)[number];

/** A factory's tile colour, the same for its id every time. */
export function factoryHue(factoryId: string): FactoryHue {
  // FNV-1a over the id's code units: small, stable and spread enough for a handful of colours.
  let hash = 0x811c9dc5;
  for (let index = 0; index < factoryId.length; index++) {
    hash ^= factoryId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return FACTORY_HUES[(hash >>> 0) % FACTORY_HUES.length] ?? FACTORY_HUES[0];
}
