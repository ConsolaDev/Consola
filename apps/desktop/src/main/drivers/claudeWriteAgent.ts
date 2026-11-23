import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ClaudeSandboxSettings } from '../../shared/agentGrants';
import { CONSOLA_MCP_SERVER, mcpToolName, READ_ONLY_CONSOLA_TOOLS } from '../mcp/names';

export type { ClaudeSandboxSettings };

/*
 * A write agent's launch on Claude (slice 3-B Task 17): what its shell may
 * not read, its sandbox, its file tools' deny rules and its flags. Pure but
 * for `realpath`. `scripts/claude-step-flags.mjs` writes the same out for the
 * real-CLI canary, and `claudeStepsCanary.test.ts` keeps the two equal.
 *
 * Each verdict below is what the canary's rows 29 to 48 showed on Claude
 * 2.1.330 (macOS 26.3, 2026-11-22; the s3-build ledger's *3-B Task 2
 * records*). A `true` the ledger does not show is never written here.
 */

/** Row 35 (PASS): `allowRead` inside a denied folder lets a skill's script run there, and nothing else. */
export const ALLOW_READ_CHECKED = true;

/** Row 40 (PASS): `--max-budget-usd` ends a turn (`subtype: error_max_budget_usd`, `is_error: true`). */
export const MAX_BUDGET_CHECKED = true;

/**
 * Row 30's outside half (PASS on 2.1.330, `HOST_EDIT_CHECKED = true` in
 * the ledger's *3-B Task 2 records*): with the sandbox off (an `edit`
 * agent on `host`), the file tools changed nothing outside the checkout
 * (both outside files absent, each named as refused), held by
 * `--restricted`. The card drops its "not yet checked on host" hedge on it.
 */
export const HOST_EDIT_CHECKED = true;

/**
 * Row 44 (PASS): the file tools read nothing the shell's deny list holds, so
 * row 45 did not run. The reason is `--restricted`, not `denyRead`: they
 * refuse every path outside the working directory, and ignore `denyRead`
 * inside it.
 */
export const FILE_TOOLS_DENY_CHECKED = true;

/**
 * Row 50 (the 3-B code review's F6): whether the file tools read through a
 * symbolic link inside the checkout that leads out of it (absolute, `../`, a
 * link to a link, a linked folder, one the sandboxed shell made). Not
 * observed: the row's first run, on 2.1.330 (2026-11-23), got no turn, as the
 * canary's profile had hit its weekly limit ("resets Nov 26"). Until it
 * passes, the card says so (`FILE_TOOL_LINKS_HEDGE`); Consola refuses to
 * commit such a link whatever it finds (`node/runCheckout.ts`), so none
 * reaches a later step.
 */
export const FILE_TOOLS_LINKS_CHECKED = false;

/** Row 44 passed, so no `Read(…)` deny rule is compiled for the deny list (Call 22). */
export const FILE_TOOL_RULES_NEEDED = false;

/** Row 43 (PASS): the sandboxed shell reached no Unix-domain socket with no key set (Call 23). */
export const UNIX_SOCKETS_PINNED = false;

/** The keys row 43 would pin shut, as the CLI names them; spread into `network` only when UNIX_SOCKETS_PINNED. */
export const PINNED_SOCKET_KEYS: { allowUnixSockets: []; allowAllUnixSockets?: false } = {
  allowUnixSockets: [],
  allowAllUnixSockets: false,
};

/**
 * Row 49 (INFO, 2026-11-23, on 2.1.330): denying `Library/Keychains` denies
 * the keychain *files* only. A sandboxed shell still reaches the keychain
 * service (securityd, `com.apple.SecurityServer`, over Mach IPC): the CLI's
 * own sandbox profile allows that lookup outright, and its settings offer
 * no way to deny it (`network.allowMachLookup` only adds lookups). Asked for
 * an item under a name that cannot exist, `security find-generic-password`
 * answered "could not be found", and `security list-keychains` listed the
 * search list, as outside the sandbox. So a sandboxed step can ask macOS for
 * your keychain items through `security` (macOS may or may not prompt), and
 * nothing Consola says may describe the sandbox as protecting the keychain.
 */
export const KEYCHAIN_SERVICE_BLOCKED = false;

/**
 * The credential files and folders, under the home folder, that a `sandbox`
 * shell may not read (Call 21's fixed list; the canary's `CREDENTIAL_PATHS`),
 * and each agent CLI's default profile. `Library/Keychains` keeps the
 * keychain files from being read or copied whole; it does not keep the shell
 * from asking the keychain service for an item (`KEYCHAIN_SERVICE_BLOCKED`,
 * row 49), which is where Git's osxkeychain helper, `gh` and Claude keep
 * their sign-ins. Denying a profile folder leaves the agent running: row 46
 * denied its own profile and another (2.1.330).
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
] as const;

/** Electron's `userData` with the suffixes a dev and a test run add (`index.ts`' `PROFILE_SUFFIX`). */
const USER_DATA_SUFFIXES = [' Dev', ' Test'] as const;

/** `userData` and its ` Dev` and ` Test` siblings, whichever of the three it is. */
export function userDataFamily(userData: string): string[] {
  const suffix = USER_DATA_SUFFIXES.find((candidate) => userData.endsWith(candidate));
  const base = suffix ? userData.slice(0, -suffix.length) : userData;
  return [base, ...USER_DATA_SUFFIXES.map((candidate) => `${base}${candidate}`)];
}

/** The path as the file system has it once its links are followed, or as given when it is not there. */
function realOrAsGiven(entry: string): string {
  try {
    return fs.realpathSync.native(entry);
  } catch {
    return entry;
  }
}

/**
 * Call 21's list (review B2): the credential list under `home`, the factory
 * root (every factory and run folder), `userData` and its siblings (the
 * workspaces, harnesses, run history and each session's MCP socket and
 * token), and every harness's effective profile; each through `realpath`
 * where it exists, sorted, unique. Never the worktree root, which holds the
 * checkout, nor `~/.consola/run-git`, whose git folder the agent reads.
 */
export function denyReadList(input: {
  home: string;
  userData: string;
  factoryRoot: string;
  profiles: readonly string[];
}): string[] {
  const list = [
    ...CREDENTIAL_PATHS.map((rest) => path.posix.join(input.home, rest)),
    input.factoryRoot,
    ...userDataFamily(input.userData),
    ...input.profiles,
  ];
  return [...new Set(list.map(realOrAsGiven))].sort();
}

/**
 * A step's sandbox: the shell runs only sandboxed (no unsandboxed retry,
 * none asked), reaches only the environment's hosts (an empty list is no
 * network; nothing of Consola's own, no loopback: the conductor's ruling on
 * canary row 39), may not read the deny list, and may not write the
 * checkout's `.git` pointer. `allowRead` holds the step's plugin folder,
 * inside the denied factory root, only once row 35 passed.
 */
export function sandboxSettings(
  environment: { network: readonly string[] },
  denyRead: readonly string[],
  checkout: string,
  pluginDir?: string,
): ClaudeSandboxSettings {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [...environment.network],
      ...(UNIX_SOCKETS_PINNED ? PINNED_SOCKET_KEYS : {}),
    },
    filesystem: {
      denyRead: [...denyRead],
      denyWrite: [path.posix.join(checkout, '.git')],
      ...(ALLOW_READ_CHECKED && pluginDir !== undefined ? { allowRead: [pluginDir] } : {}),
    },
  };
}

/** An absolute path as a permission rule names it: `//` and the path without its leading `/`. */
function rulePath(absolute: string): string {
  return `//${absolute.replace(/^\/+/, '')}`;
}

/**
 * The file tools' deny rules: `Edit` and `Write` of the checkout's `.git`
 * pointer always (Call 9), and, only where the canary found the file tools
 * read what the shell may not (FILE_TOOL_RULES_NEEDED, Call 22), `Read` of
 * each deny-list entry, as a file and as a folder.
 */
export function fileToolDenyRules(denyRead: readonly string[], checkout: string): string[] {
  return [
    ...(FILE_TOOL_RULES_NEEDED
      ? denyRead.flatMap((entry) => [`Read(${rulePath(entry)})`, `Read(${rulePath(entry)}/**)`])
      : []),
    `Edit(${rulePath(checkout)}/.git)`,
    `Write(${rulePath(checkout)}/.git)`,
  ];
}

/**
 * Call 24 (review S7): the person's own sandbox settings, which `--settings`
 * may not override. The first file that sets `sandbox`, or that cannot be
 * read as JSON, refuses `sandbox` in its words; null when none does. `text:
 * null` is a file that is not there.
 */
export function sandboxSettingsProblem(
  files: ReadonlyArray<{ path: string; text: string | null; unreadable?: string }>,
): string | null {
  for (const file of files) {
    if (file.unreadable !== undefined)
      return `${file.path} could not be read (${file.unreadable}), so Consola can't check whether it sets \`sandbox\`. Fix it, or give write agents a harness of their own.`;
    if (file.text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      return `${file.path} is not JSON, so Consola can't check whether it sets \`sandbox\`. Fix it, or give write agents a harness of their own.`;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, 'sandbox')
    )
      return `${file.path} sets \`sandbox\`, which Claude may add to this agent's sandbox, and Consola can't check what it changes. Remove it there, or give write agents a harness of their own.`;
  }
  return null;
}

/** A write agent's tools, by its `tools:`. */
const WRITE_TOOLS = { edit: 'Read,Grep,Glob,Edit,Write', write: 'Read,Grep,Glob,Edit,Write,Bash' };

/** What a write agent may use without asking, beside Consola's read-only tools. */
const WRITE_ALLOWED = { edit: ['Edit', 'Write'], write: ['Edit', 'Write', 'Bash'] };

/**
 * On `host`, a convention its shell can go around: no `git push`, no `gh`.
 * Under `sandbox` the network list and the git folder outside the checkout
 * hold it instead.
 */
const HOST_SHELL_DENY = ['Bash(git push:*)', 'Bash(gh:*)'];

/**
 * A write agent's policy flags, in the canary's order (`writeAgentFlags`):
 * `--strict-mcp-config` unless a connector is granted, `--permission-mode
 * dontAsk`, `--tools Read,Grep,Glob,Edit,Write[,Bash][,Skill]`,
 * `--allowedTools <Consola's read-only tools> Edit Write [Bash] <the grants'
 * rules>`, `--disallowedTools` with `deny` (the file tools' rules and the
 * skills' deny rules) and, on `host` with a shell, `Bash(git push:*)
 * Bash(gh:*)`, then `--restricted`, last and always.
 */
export function writeAgentArgs(grant: {
  tools: 'edit' | 'write';
  isolation: 'host' | 'sandbox';
  strict?: boolean;
  skills?: boolean;
  allowed?: readonly string[];
  deny?: readonly string[];
}): string[] {
  const deny = [
    ...(grant.deny ?? []),
    ...(grant.tools === 'write' && grant.isolation === 'host' ? HOST_SHELL_DENY : []),
  ];
  return [
    ...(grant.strict === false ? [] : ['--strict-mcp-config']),
    '--permission-mode',
    'dontAsk',
    '--tools',
    grant.skills ? `${WRITE_TOOLS[grant.tools]},Skill` : WRITE_TOOLS[grant.tools],
    '--allowedTools',
    ...READ_ONLY_CONSOLA_TOOLS.map((tool) => `mcp__${CONSOLA_MCP_SERVER}__${mcpToolName(tool)}`),
    ...WRITE_ALLOWED[grant.tools],
    ...(grant.allowed ?? []),
    ...(deny.length > 0 ? ['--disallowedTools', ...deny] : []),
    // Last, and taking no value: it closes the variadic tool lists above. Never left out.
    '--restricted',
  ];
}

/**
 * `--max-budget-usd <what is left>` for an unattended reporting turn of a run
 * with a budget, only once canary row 40 showed the CLI ends a turn at it
 * (Call 15); empty otherwise. Rounded down to the cent, at least a cent.
 */
export function budgetFlags(
  maxBudgetUsd: number | undefined,
  checked = MAX_BUDGET_CHECKED,
): string[] {
  if (!checked || maxBudgetUsd === undefined || !Number.isFinite(maxBudgetUsd)) return [];
  const cents = Math.max(1, Math.floor(maxBudgetUsd * 100 + 1e-9));
  return ['--max-budget-usd', (cents / 100).toFixed(2)];
}
