/**
 * A step's read-only flags, as the real-CLI canary (`claude-steps-canary.mjs`)
 * passes them: what `src/main/drivers/ClaudeDriver.ts` (`READ_ONLY_ARGS`)
 * launches a step's turn with, written out because the canary imports
 * nothing from the app. `src/main/drivers/claudeStepsCanary.test.ts` keeps
 * the two equal. Plain Node, no imports, nothing done on import.
 */

/** The tool a step's agent reports its outputs with, as Claude names it. */
export const SET_OUTPUTS = 'mcp__consola__consola_set_outputs';

/**
 * A step's read-only flags; each canary row allows its own tools beside
 * `SET_OUTPUTS`. `strict` (on unless an agent's grants name a connector)
 * puts `--strict-mcp-config` first; `deny` rules go after
 * `--disallowedTools`, before `--restricted`.
 */
export function stepFlags({
  tools = 'Read,Grep,Glob',
  allowed = [],
  restricted = true,
  strict = true,
  deny = [],
} = {}) {
  return [
    ...(strict ? ['--strict-mcp-config'] : []),
    '--permission-mode',
    'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    SET_OUTPUTS,
    ...allowed,
    ...(deny.length > 0 ? ['--disallowedTools', ...deny] : []),
    // Last, and taking no value: it closes the variadic tool lists above.
    ...(restricted ? ['--restricted'] : []),
  ];
}

/**
 * The flags a step's turn carries once its agent's grants are compiled, in
 * the driver's order: `--mcp-config` (Consola's file, then the account
 * file), the one `--settings`, `--plugin-dir` and `--add-dir`, then
 * stepFlags with the grants' tools, allow and deny rules.
 *
 * `settings` is the object `--settings` carries, written with
 * `JSON.stringify` in the key order given (`hooks`, then
 * `allowedMcpServers`); `mcpConfig` is the list after `--mcp-config`.
 */
export function agentFlags({
  mcpConfig = [],
  settings,
  pluginDir,
  strict = true,
  tools,
  allowed = [],
  deny = [],
} = {}) {
  return [
    ...(mcpConfig.length > 0 ? ['--mcp-config', ...mcpConfig] : []),
    ...(settings ? ['--settings', JSON.stringify(settings)] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir, '--add-dir', pluginDir] : []),
    ...stepFlags({ tools, allowed, strict, deny }),
  ];
}
