/**
 * The published types (`types/index.d.ts`, written by hand) are the source's: checked by
 * `pnpm typecheck`, which fails when a prop, a modifier or an export differs. Nothing imports
 * this file; it holds only types.
 */
import type * as Published from '@consola/agent-ui';
import type * as Source from './index.ts';

/** Whether `A` and `B` are the same type, `readonly` and optional modifiers included. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<Check extends true> = Check;

export type PublishedTypesAreTheSource = [
  Expect<Same<Published.AgentChatProps, Source.AgentChatProps>>,
  Expect<Same<typeof Published.AgentChat, typeof Source.AgentChat>>,
  // The values each exports: a component added to `src/index.ts` must be published too.
  Expect<Same<keyof typeof Published, keyof typeof Source>>,
];
