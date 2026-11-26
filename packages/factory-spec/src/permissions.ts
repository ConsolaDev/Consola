/**
 * `permissions:` on a `run:` step: the GitHub permissions its command needs, by GitHub's own
 * names, each `read` or `write` (`permissions: { pull_requests: write }`).
 *
 * What a runner does with them is the runner's. On a cloud runner a step that names
 * permissions gets a GitHub token narrowed to them, for that step alone, and a step that names
 * none gets no token. On the desktop a command already runs as the workspace's bound account
 * (decision 37), so there the key is parsed, versioned and has no effect. Either way it is part
 * of what the automation's version hashes, since it changes what the step may do.
 *
 * Imports nothing of `steps.ts` or `uses.ts`, which import this file.
 */

/** The permissions a step may ask for, GitHub's names, in the order a parsed step keeps them. */
export const GITHUB_PERMISSIONS = [
  'contents',
  'pull_requests',
  'issues',
  'checks',
  'statuses',
  'metadata',
] as const;
export type GitHubPermission = (typeof GITHUB_PERMISSIONS)[number];

/** What a step may do with one: read it, or read and write it. */
export type PermissionAccess = 'read' | 'write';

/** A step's `permissions:` as parsed: only the names it writes, in `GITHUB_PERMISSIONS`' order. */
export type StepPermissions = Partial<Record<GitHubPermission, PermissionAccess>>;

/** Every GitHub token can read `metadata`, and none can write it. */
const READ_ONLY: ReadonlySet<GitHubPermission> = new Set<GitHubPermission>(['metadata']);

/** Why an agent step takes no `permissions:`. */
export const AGENT_PERMISSIONS_REASON =
  'An agent step gets no GitHub token: `permissions:` goes on the `run:` step whose command acts.';
/** Why a call takes none. */
export const USES_PERMISSIONS_REASON =
  "A tool call acts with its server's own credentials: `permissions:` goes on a `run:` step.";
/** Why a loop takes none. */
export const LOOP_PERMISSIONS_REASON =
  'A loop runs only its steps: `permissions:` goes on the `run:` step inside it that needs them.';
/** Why an entry takes none. */
export const ENTRY_PERMISSIONS_REASON = '`permissions:` goes on the `run:` step that needs it.';

const SHAPE =
  'Expected `permissions` to map GitHub permissions to `read` or `write`, e.g. `permissions: { pull_requests: write }`.';
const EMPTY =
  'Name at least one permission, e.g. `permissions: { pull_requests: write }`; a command that needs no GitHub token leaves `permissions:` out.';
const NAMES = `${GITHUB_PERMISSIONS.slice(0, -1).join(', ')} and ${GITHUB_PERMISSIONS[GITHUB_PERMISSIONS.length - 1]}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isPermission = (name: string): name is GitHubPermission =>
  (GITHUB_PERMISSIONS as readonly string[]).includes(name);

/** Why `name` is no permission a step can ask for: the spelling GitHub's API uses, when it is one. */
function unknownName(name: string): string {
  const underscored = name.replace(/-/g, '_');
  if (underscored !== name && isPermission(underscored)) {
    return `Write \`${underscored}\`, as GitHub's API names it.`;
  }
  return `\`${name}\` is not a permission a step can ask for; a step asks for ${NAMES}.`;
}

/**
 * A `run:` step's `permissions:` as written, in `GITHUB_PERMISSIONS`' order, or null once
 * anything was reported. Each issue's path is from the key: `[]` for the map, `[name]` for one
 * of its entries.
 */
export function parsePermissions(
  raw: unknown,
  fail: (message: string, path?: Array<string | number>) => void,
): StepPermissions | null {
  if (!isRecord(raw)) {
    fail(SHAPE);
    return null;
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    fail(EMPTY);
    return null;
  }
  const given: StepPermissions = {};
  let ok = true;
  for (const name of names) {
    const access = raw[name];
    let problem: string | undefined;
    if (!isPermission(name)) problem = unknownName(name);
    else if (access !== 'read' && access !== 'write') {
      problem = `Expected \`read\` or \`write\` for \`${name}\`.`;
    } else if (access === 'write' && READ_ONLY.has(name)) {
      problem = `\`${name}\` is read-only on GitHub: write \`${name}: read\`.`;
    }
    if (problem === undefined) given[name as GitHubPermission] = access as PermissionAccess;
    else {
      ok = false;
      fail(problem, [name]);
    }
  }
  if (!ok) return null;
  const ordered: StepPermissions = {};
  for (const name of GITHUB_PERMISSIONS) if (given[name] !== undefined) ordered[name] = given[name];
  return ordered;
}
