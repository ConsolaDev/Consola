import { createAuthClient } from 'better-auth/react';
import { messageForActionFailure } from '../domain/messages';

// No baseURL: the page and the API share one origin, through the dev server's /api proxy.
const client = createAuthClient();

/** Resolves to null when the call went through, else the sentence to show. Never rejects. */
async function attempt(call: () => Promise<{ error: unknown }>): Promise<string | null> {
  try {
    const { error } = await call();
    return error ? messageForActionFailure(error) : null;
  } catch (thrown) {
    return messageForActionFailure(thrown);
  }
}

/**
 * Signs in with Google, coming back to `returnTo`, a path of this page's own (`/`, or a one-time
 * link's `/#/slack/link/<token>`), whether sign-in finished or failed.
 */
export function signInWithGoogle(returnTo = '/'): Promise<string | null> {
  return attempt(() =>
    client.signIn.social({ provider: 'google', callbackURL: returnTo, errorCallbackURL: returnTo }),
  );
}

/** Reloads only once signed out; otherwise resolves to the sentence to show. */
export async function signOut(): Promise<string | null> {
  const failure = await attempt(() => client.signOut());
  if (failure === null) window.location.reload();
  return failure;
}
