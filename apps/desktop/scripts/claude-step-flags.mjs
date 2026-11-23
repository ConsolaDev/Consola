/**
 * A step's read-only flags, as the real-CLI canary (`claude-steps-canary.mjs`)
 * passes them: what `src/main/drivers/ClaudeDriver.ts` (`READ_ONLY_ARGS`)
 * launches a step's turn with, written out because the canary imports
 * nothing from the app. `src/main/drivers/claudeStepsCanary.test.ts` keeps
 * the two equal. A write agent's flags, Consola's deny list and its file
 * tools' deny rules (slice 3-B, rows 29 to 48) are written out the same way,
 * for the driver's write agents to be kept equal to. Plain Node, no
 * imports, nothing done on import.
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

/** A write agent's tools, by its `tools:`, in the order the driver lists them (Task 17). */
const WRITE_TOOLS = {
  edit: 'Read,Grep,Glob,Edit,Write',
  write: 'Read,Grep,Glob,Edit,Write,Bash',
};

/** What a write agent's turn allows beside Consola's read-only tools, by its `tools:`. */
const WRITE_ALLOWED = { edit: ['Edit', 'Write'], write: ['Edit', 'Write', 'Bash'] };

/** `--settings`' keys in the order the driver writes them; any other key after, as given. */
const SETTINGS_ORDER = ['hooks', 'sandbox', 'allowedMcpServers'];

/**
 * A write agent's turn flags in the driver's order (Task 17 keeps them equal):
 * `--settings` (one object: `hooks`, then `sandbox` when given, then
 * `allowedMcpServers`; left out when it holds nothing), `--plugin-dir` when
 * the agent has skills (never `--add-dir`: for a write agent that would make
 * the folder one its file tools may write), `--strict-mcp-config` unless a
 * connector is granted, then `--permission-mode dontAsk`,
 * `--tools <Read,Grep,Glob,Edit,Write[,Bash][,Skill]>`,
 * `--allowedTools <Consola's read-only tools, Edit, Write[, Bash][, its skills]>`,
 * `--disallowedTools <deny>` when any, and `--restricted` last, always.
 */
export function writeAgentFlags({
  tools,
  settings,
  deny = [],
  strict = true,
  pluginDir,
  skills = [],
} = {}) {
  if (!(tools in WRITE_TOOLS))
    throw new Error(`writeAgentFlags: tools is 'edit' or 'write', not ${String(tools)}`);
  const ordered = {};
  for (const key of SETTINGS_ORDER) if (settings?.[key] !== undefined) ordered[key] = settings[key];
  for (const [key, value] of Object.entries(settings ?? {}))
    if (!(key in ordered)) ordered[key] = value;
  return [
    ...(Object.keys(ordered).length > 0 ? ['--settings', JSON.stringify(ordered)] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    ...(strict ? ['--strict-mcp-config'] : []),
    '--permission-mode',
    'dontAsk',
    '--tools',
    skills.length > 0 ? `${WRITE_TOOLS[tools]},Skill` : WRITE_TOOLS[tools],
    '--allowedTools',
    SET_OUTPUTS,
    ...WRITE_ALLOWED[tools],
    ...skills.map((name) => `Skill(consola-step:${name})`),
    ...(deny.length > 0 ? ['--disallowedTools', ...deny] : []),
    // Last, and taking no value: it closes the variadic tool lists above. Never left out.
    '--restricted',
  ];
}

/**
 * The CLI's credential files and folders Consola adds to what a `sandbox`
 * shell may not read, under the home folder (plan Call 21).
 */
export const CREDENTIAL_PATHS = [
  'Library/Keychains',
  '.claude.json',
  '.ssh',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.config/glab-cli',
  '.kube',
  '.gnupg',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/git/credentials',
  // Each agent CLI's default profile, whatever the harness records name (the 3-B code review's F1):
  // Claude's, Codex's, Gemini's and Antigravity's (`~/.gemini`).
  '.claude',
  '.codex',
  '.gemini',
];

/**
 * Call 21's list, the canary's copy (Task 17's `denyReadList` is kept equal
 * to it by a parity row): the credential paths under `home`, the factory
 * root, `userData` with its ` Dev` and ` Test` siblings, and every
 * harness's effective profile; each through `realpath` (the caller's: it
 * answers the path as it is when it does not exist), sorted, unique.
 */
export function denyReadListFor({
  home,
  userData,
  factoryRoot,
  profiles = [],
  realpath = (p) => p,
}) {
  const list = [
    ...CREDENTIAL_PATHS.map((rest) => `${home}/${rest}`),
    factoryRoot,
    userData,
    `${userData} Dev`,
    `${userData} Test`,
    ...profiles,
  ];
  return [...new Set(list.map((entry) => realpath(entry)))].sort();
}

/** An absolute path as a permission rule names it: `//` and the path without its leading `/`. */
function rulePath(absolute) {
  return `//${absolute.replace(/^\/+/, '')}`;
}

/**
 * Call 22's rules: for each entry of the deny list `Read(//<path>)` and
 * `Read(//<path>/**)` (an entry can be a file, such as `~/.claude.json`,
 * which `<path>/**` alone would not name), then `Edit(//<checkout>/.git)`
 * and `Write(//<checkout>/.git)` (Call 9's pointer).
 */
export function fileToolDenyRules(list, checkout) {
  return [
    ...list.flatMap((entry) => [`Read(${rulePath(entry)})`, `Read(${rulePath(entry)}/**)`]),
    `Edit(${rulePath(checkout)}/.git)`,
    `Write(${rulePath(checkout)}/.git)`,
  ];
}
