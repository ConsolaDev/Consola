import type { Session } from './workspace';

/**
 * How a session's conversation would reach another harness.
 *
 * - `native`: both harnesses run the same CLI, which forks the conversation
 *   itself once its transcript is where that harness looks — nothing is lost.
 * - `handoff`: the new harness starts a fresh conversation and reads a
 *   transcript of the old one: prompts, replies and the tools used, without
 *   what those tools returned.
 * - `unstarted`: nothing has been said yet, so there is nothing to carry.
 */
export type HarnessSwitchMode = 'native' | 'handoff' | 'unstarted';

/**
 * What switching a session to one harness would do, decided in main so the
 * renderer never reasons about drivers. `summary` and `reason` are written
 * for the person choosing.
 */
export type HarnessSwitchPreview =
  | { harnessId: string; ok: true; mode: HarnessSwitchMode; summary: string }
  | { harnessId: string; ok: false; reason: string };

/**
 * What a switch did, which may be less than its preview promised — a
 * conversation found empty starts fresh. `summary` is said to the person by
 * Consola itself: a CLI that opens on its own screen (Claude does) hides
 * anything printed in the terminal before it.
 */
export interface HarnessSwitchResult {
  session: Session;
  mode: HarnessSwitchMode;
  summary: string;
}
