import type { components } from './apiContract';

/** Who is signed in, and the workspace their session has active, if any. */
export type Me = components['schemas']['Me'];

/**
 * What stands in for a person's picture when they have none: the first letters of their first
 * two words, capitalised, or `?` for a name with no letters.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

export type MeState =
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
