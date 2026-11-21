import { createAuthClient } from 'better-auth/react';
import { messageForActionFailure } from './signInError';

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

export function signInWithGoogle(): Promise<string | null> {
  return attempt(() =>
    client.signIn.social({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' }),
  );
}

/** Reloads only once signed out; otherwise resolves to the sentence to show. */
export async function signOut(): Promise<string | null> {
  const failure = await attempt(() => client.signOut());
  if (failure === null) window.location.reload();
  return failure;
}
