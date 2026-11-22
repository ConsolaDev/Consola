/**
 * A name in a factory: an automation's (people type it into `run_automation`
 * and see it in history), and an agent's, a skill's or an automation file's,
 * whose name is its path. Its own module so `steps.ts` and `schema.ts`, which
 * import each other's values, can both use it without a cycle.
 */
export const AUTOMATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
