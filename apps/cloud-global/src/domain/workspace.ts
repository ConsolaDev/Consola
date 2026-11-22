import type { WorkspaceRole } from '@consola/cloud-contract';
import { isRegion, type Region } from './region.js';

/**
 * A workspace: the top level people see, as in Notion (a company, a team, or only you). It is
 * Better Auth's `organization` row. Its slug is unique across every region, and its region is
 * picked when it is made and never changed.
 */
export type Workspace = { id: string; name: string; slug: string; region: Region };

/** A workspace as one of its members sees it: with their role in it. */
export type MyWorkspace = Workspace & { role: WorkspaceRole };

/** What a person asks for when they make a workspace, once `checkNewWorkspace` accepts it. */
export type NewWorkspace = { name: string; slug: string; region: Region };

/** The role of the person who makes a workspace. */
export const CREATOR_ROLE: WorkspaceRole = 'owner';

export const WORKSPACE_NAME_MAX = 64;
export const WORKSPACE_SLUG_MAX = 48;

/** Lowercase letters and digits, with single dashes between them. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What `checkNewWorkspace` can find wrong with a request, in the order it names them. */
export const WORKSPACE_PROBLEMS = [
  'name_missing',
  'name_too_long',
  'slug_invalid',
  'region_unknown',
] as const;

export type WorkspaceProblem = (typeof WORKSPACE_PROBLEMS)[number];

/**
 * Whether a request for a new workspace can be made: a name (trimmed, at most
 * `WORKSPACE_NAME_MAX` characters), a slug of lowercase letters and digits with single dashes
 * between (at most `WORKSPACE_SLUG_MAX`), and one of `REGIONS`. Every problem is named at once,
 * in that order. Whether the slug is free is the store's to say, since only it sees every region.
 */
export function checkNewWorkspace(input: {
  name?: unknown;
  slug?: unknown;
  region?: unknown;
}): { ok: true; workspace: NewWorkspace } | { ok: false; problems: WorkspaceProblem[] } {
  const problems: WorkspaceProblem[] = [];

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') problems.push('name_missing');
  else if (name.length > WORKSPACE_NAME_MAX) problems.push('name_too_long');

  const slug = typeof input.slug === 'string' ? input.slug : '';
  if (slug.length > WORKSPACE_SLUG_MAX || !SLUG.test(slug)) problems.push('slug_invalid');

  const region = isRegion(input.region) ? input.region : null;
  if (region === null) problems.push('region_unknown');

  if (region === null || problems.length > 0) return { ok: false, problems };
  return { ok: true, workspace: { name, slug, region } };
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
