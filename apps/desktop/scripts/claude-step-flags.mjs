/**
 * A step's read-only flags, as the real-CLI canary (`claude-steps-canary.mjs`)
 * passes them: what `src/main/drivers/ClaudeDriver.ts` (`READ_ONLY_ARGS`)
 * launches a step's turn with, written out because the canary imports
 * nothing from the app. `src/main/drivers/claudeStepsCanary.test.ts` keeps
 * the two equal. Plain Node, no imports, nothing done on import.
 */

/** The tool a step's agent reports its outputs with, as Claude names it. */
export const SET_OUTPUTS = 'mcp__consola__consola_set_outputs';

/** A step's read-only flags; each canary row allows its own tools beside `SET_OUTPUTS`. */
export function stepFlags({ tools = 'Read,Grep,Glob', allowed = [], restricted = true } = {}) {
  return [
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    SET_OUTPUTS,
    ...allowed,
    // Last, and taking no value: it closes the variadic tool list above.
    ...(restricted ? ['--restricted'] : []),
  ];
}
