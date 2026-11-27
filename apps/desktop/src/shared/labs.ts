/**
 * Features that are hidden from everyone except the people who turn them on
 * on their own computer, in `~/.consola/labs.json` (main reads it once per
 * launch). There are no remote flags, so a fresh install, which has no file,
 * shows none of them.
 *
 * ```json
 * { "automations": true }
 * ```
 */
export interface Labs {
  /**
   * The Automations section: the sidebar item and dashboard, the runs
   * waiting in the sidebar, Settings › Secrets, and the agent tools whose
   * answers or approvals live there.
   */
  automations: boolean;
}

/** What a computer with no labs file, or an unreadable one, gets: every lab off. */
export const NO_LABS: Labs = { automations: false };

/** Every lab on: what a test run gets unless it says otherwise. */
export const ALL_LABS: Labs = { automations: true };

/**
 * A labs file's text as the labs it turns on. Only a literal `true` turns
 * one on, and anything unreadable (no file, bad JSON, not an object) turns
 * on nothing.
 */
export function parseLabs(text: string | null | undefined): Labs {
  if (!text) return NO_LABS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NO_LABS;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NO_LABS;
  return { automations: (value as Record<string, unknown>).automations === true };
}
