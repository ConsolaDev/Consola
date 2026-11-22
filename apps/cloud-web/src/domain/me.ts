import type { components } from './apiContract';

/** Who is signed in, and the workspace their session has active, if any. */
export type Me = components['schemas']['Me'];

export type MeState =
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
