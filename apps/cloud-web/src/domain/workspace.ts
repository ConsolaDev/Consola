import type { components } from './apiContract';

/**
 * Workspaces as the web app sees them. `cloud-global` is the authority on every rule here: the
 * web app imports no package, so it keeps its own copy, to check a request before sending it
 * and to suggest a slug. When the server disagrees, its answer is what the page shows. The
 * copies are checked against the API's contract (`apiContract.ts`) as the app typechecks, so the
 * API cannot gain a region, a role or a problem the page does not name.
 */

/** The regions a workspace can be in, with the names the page gives them. */
export const REGIONS = [
  { id: 'eu', name: 'EU', place: 'Europe' },
  { id: 'us', name: 'US', place: 'United States' },
] as const;

export type Region = (typeof REGIONS)[number]['id'];

export function isRegion(value: unknown): value is Region {
  return REGIONS.some((region) => region.id === value);
}

/** What the page calls a region; one it does not list is shown as the server sent it. */
export function regionName(region: string): string {
  return REGIONS.find((listed) => listed.id === region)?.name ?? region;
}

/** A workspace as the person signed in sees it: with their role in it. */
export type MyWorkspace = components['schemas']['MyWorkspace'];

/** What the page calls each role the API has: one more there fails the typecheck here. */
const ROLE_NAMES = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
} satisfies Record<MyWorkspace['role'], string>;

/** What the page calls a role; one it does not know is shown as the server sent it. */
export function roleName(role: string): string {
  return Object.hasOwn(ROLE_NAMES, role) ? ROLE_NAMES[role as keyof typeof ROLE_NAMES] : role;
}

/** What a person asks for when they make a workspace, once `checkNewWorkspace` accepts it. */
export type NewWorkspace = { name: string; slug: string; region: Region };

export const WORKSPACE_NAME_MAX = 64;
export const WORKSPACE_SLUG_MAX = 48;

/** Lowercase letters and digits, with single dashes between them. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const WORKSPACE_PROBLEMS = [
  'name_missing',
  'name_too_long',
  'slug_invalid',
  'region_unknown',
] as const;

/** Why the server, or the page's own check, refuses a request for a new workspace. */
export type WorkspaceProblem = (typeof WORKSPACE_PROBLEMS)[number];

export function isWorkspaceProblem(value: unknown): value is WorkspaceProblem {
  return WORKSPACE_PROBLEMS.some((problem) => problem === value);
}

/**
 * Whether a request for a new workspace can be sent: a name (trimmed, at most
 * `WORKSPACE_NAME_MAX` characters), a slug of lowercase letters and digits with single dashes
 * between (at most `WORKSPACE_SLUG_MAX`), and one of `REGIONS`. Every problem is named at once,
 * in that order. Whether the slug is free only the server can say.
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

/** Letters an accent cannot be taken off, spelled the way a slug can hold them. */
const SPELLED: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};
const UNSPELLED = new RegExp(`[${Object.keys(SPELLED).join('')}]`, 'g');

/**
 * A slug for a workspace's name: its words lowercased, without accents and joined by single
 * dashes, as many whole words as fit in `WORKSPACE_SLUG_MAX`. A letter that is not a-z once its
 * accent is gone (Japanese, say) separates words, so a name with none gives no slug.
 */
export function suggestSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(UNSPELLED, (letter) => SPELLED[letter] ?? letter)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');

  let slug = '';
  for (const word of words) {
    const longer = slug === '' ? word : `${slug}-${word}`;
    if (longer.length > WORKSPACE_SLUG_MAX) {
      return slug === '' ? word.slice(0, WORKSPACE_SLUG_MAX) : slug;
    }
    slug = longer;
  }
  return slug;
}

/**
 * The create form as the person fills it in. The slug follows the name (`suggestSlug`) until
 * the person types one of their own (`slugEdited`), and no region is picked for them, since it
 * can never be changed.
 */
export type WorkspaceDraft = {
  name: string;
  slug: string;
  region: Region | null;
  slugEdited: boolean;
};

export const NEW_DRAFT: WorkspaceDraft = { name: '', slug: '', region: null, slugEdited: false };

/** The draft with a new name; the slug follows it unless the person typed their own. */
export function withName(draft: WorkspaceDraft, name: string): WorkspaceDraft {
  return { ...draft, name, slug: draft.slugEdited ? draft.slug : suggestSlug(name) };
}

/** The draft with a slug the person typed, lowercased. Emptying it hands it back to the name. */
export function withSlug(draft: WorkspaceDraft, slug: string): WorkspaceDraft {
  const lowered = slug.toLowerCase();
  return { ...draft, slug: lowered, slugEdited: lowered !== '' };
}

/** The person's workspaces, in the order they joined. */
export type WorkspacesState =
  | { kind: 'listed'; workspaces: MyWorkspace[] }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What the server answered a request for a new workspace. */
export type CreateWorkspaceAnswer =
  | { kind: 'created'; workspace: MyWorkspace }
  | { kind: 'invalid'; problems: WorkspaceProblem[] }
  | { kind: 'slug-taken' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };

/** What the server answered a request to open another workspace. */
export type SwitchWorkspaceAnswer =
  | { kind: 'switched'; workspace: MyWorkspace }
  | { kind: 'not-found' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
