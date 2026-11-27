import type { WorkspaceRole } from '../../shared/workspaceRole.js';
import type { Region } from './region.js';
import type { WorkspaceIcon } from './workspaceIcon.js';

/**
 * A workspace: the top level people see, as in Notion (a company, a team, or only you). It is
 * Better Auth's `organization` row. Its slug is unique among every workspace, and its region is
 * the deployment's when it is made, never asked for and never changed.
 */
export type Workspace = { id: string; name: string; slug: string; region: Region };

/**
 * A workspace as one of its members sees it: with their role in it, and the icon it wears (null
 * for none, which shows its initial).
 */
export type MyWorkspace = Workspace & { role: WorkspaceRole; icon: WorkspaceIcon | null };

/**
 * Who may change how a workspace looks (its icon): its owners and admins. Every member sees it.
 */
export function mayManageWorkspace(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}

/** A member of a workspace, as its other members see them: who they are, and their role. */
export type WorkspaceMember = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
};

/**
 * What a person asks for when they make a workspace, once `checkNewWorkspace` accepts it. Its
 * region is not theirs to ask: every new workspace takes the deployment's.
 */
export type NewWorkspace = { name: string; slug: string };

/** The role of the person who makes a workspace. */
export const CREATOR_ROLE: WorkspaceRole = 'owner';

export const WORKSPACE_NAME_MAX = 64;
export const WORKSPACE_SLUG_MAX = 48;

/** Lowercase letters and digits, with single dashes between them. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What `checkNewWorkspace` can find wrong with a request, in the order it names them. */
export const WORKSPACE_PROBLEMS = ['name_missing', 'name_too_long', 'slug_invalid'] as const;

export type WorkspaceProblem = (typeof WORKSPACE_PROBLEMS)[number];

/**
 * Whether a request for a new workspace can be made: a name (trimmed, at most
 * `WORKSPACE_NAME_MAX` characters) and a slug of lowercase letters and digits with single dashes
 * between (at most `WORKSPACE_SLUG_MAX`). Every problem is named at once, in that order. Whether
 * the slug is free is the store's to say, since only it sees every workspace.
 */
export function checkNewWorkspace(input: {
  name?: unknown;
  slug?: unknown;
}): { ok: true; workspace: NewWorkspace } | { ok: false; problems: WorkspaceProblem[] } {
  const problems: WorkspaceProblem[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.push('name_missing');
  else if (name.length > WORKSPACE_NAME_MAX) problems.push('name_too_long');

  const slug = typeof input.slug === 'string' ? input.slug : '';
  if (slug.length > WORKSPACE_SLUG_MAX || !SLUG.test(slug)) problems.push('slug_invalid');

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, workspace: { name, slug } };
}

/**
 * The workspace a new session opens in: the one the person last had active, if they are still
 * in it, else the first they joined, else none. `memberOf` is in the order they joined.
 */
export function defaultActiveWorkspace(facts: {
  lastActive: string | null;
  memberOf: readonly string[];
}): string | null {
  if (facts.lastActive !== null && facts.memberOf.includes(facts.lastActive)) {
    return facts.lastActive;
  }
  return facts.memberOf[0] ?? null;
}
