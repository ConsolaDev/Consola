import {
  type CreateWorkspaceAnswer,
  type SwitchWorkspaceAnswer,
  WORKSPACE_NAME_MAX,
  WORKSPACE_SLUG_MAX,
  type WorkspaceProblem,
} from './workspace';
import type { SetIconAnswer } from './workspaceIcons';

const NEEDS_VERIFIED_EMAIL = 'Consola Cloud needs a Google account with a verified email address.';
const NOT_ANSWERING = 'Consola Cloud’s service isn’t answering. Try again in a moment.';

/** The sentence for a sign-in or sign-out call that failed, resolved with an error or thrown. */
export function messageForActionFailure(failure: unknown): string {
  const status =
    typeof failure === 'object' && failure !== null && 'status' in failure
      ? failure.status
      : undefined;
  if (status === 429) return 'Too many sign-in attempts. Wait a minute and try again.';
  return NOT_ANSWERING;
}

/** The sentence for the `?error=` code Google's sign-in came back with. */
export function messageForSignInError(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case 'access_denied':
      return 'Google sign-in was cancelled.';
    case 'unable_to_create_user':
    case 'email_not_verified':
      return NEEDS_VERIFIED_EMAIL;
    default:
      return 'Google sign-in didn’t finish. Try again.';
  }
}

/** What the create form says, under each of its fields and for the form as a whole. */
export type WorkspaceFormMessages = {
  name?: string;
  slug?: string;
  region?: string;
  form?: string;
};

const FOR_PROBLEM: Record<WorkspaceProblem, { field: 'name' | 'slug' | 'region'; text: string }> = {
  name_missing: { field: 'name', text: 'Give the workspace a name.' },
  name_too_long: {
    field: 'name',
    text: `Keep the name to ${WORKSPACE_NAME_MAX} characters or fewer.`,
  },
  slug_invalid: {
    field: 'slug',
    text: `Use lowercase letters, digits and single dashes, up to ${WORKSPACE_SLUG_MAX} characters.`,
  },
  region_unknown: { field: 'region', text: 'Pick a region.' },
};

/** The sentences for what the page's check, or the server, found wrong with the form. */
export function messagesForWorkspaceProblems(
  problems: readonly WorkspaceProblem[],
): WorkspaceFormMessages {
  const messages: WorkspaceFormMessages = {};
  for (const problem of problems) {
    const { field, text } = FOR_PROBLEM[problem];
    messages[field] ??= text;
  }
  return messages;
}

/** What the form says when the server did not create the workspace. */
export function messagesForCreateRefusal(
  answer: Extract<CreateWorkspaceAnswer, { kind: 'invalid' | 'slug-taken' | 'unavailable' }>,
): WorkspaceFormMessages {
  switch (answer.kind) {
    case 'invalid':
      return answer.problems.length > 0
        ? messagesForWorkspaceProblems(answer.problems)
        : { form: 'Consola Cloud didn’t accept this workspace. Check the details and try again.' };
    case 'slug-taken':
      return { slug: 'Another workspace already has this slug. Pick another.' };
    case 'unavailable':
      return { form: NOT_ANSWERING };
  }
}

/** The sentence for a workspace the server did not open. */
export function messageForSwitchFailure(
  answer: Extract<SwitchWorkspaceAnswer, { kind: 'not-found' | 'unavailable' }>,
): string {
  return answer.kind === 'not-found' ? 'You’re no longer in that workspace.' : NOT_ANSWERING;
}

/** What the switcher says when the person's workspaces could not be listed. */
export const WORKSPACES_UNAVAILABLE = 'Your workspaces couldn’t be loaded.';

/** What the create form says under the slug, before anything is wrong with it. */
export const SLUG_HINT = 'Lowercase letters, digits and dashes. No two workspaces share one.';

/** What the create form says under the regions: the one choice that is final. */
export const REGION_HINT =
  'Pick the one nearest your team. A workspace’s region can’t be changed once it’s created.';

/** What the icon picker says when the icon could not be set. */
export function messageForIconFailure(
  answer: Extract<SetIconAnswer, { kind: 'not-allowed' | 'unavailable' }>,
): string {
  return answer.kind === 'not-allowed'
    ? 'Only the workspace’s owners and admins can change its icon.'
    : NOT_ANSWERING;
}
