import { createAuthClient } from 'better-auth/react';

// No baseURL: the page and the API share one origin, through the dev server's /api proxy.
const client = createAuthClient();

export async function signInWithGoogle(): Promise<void> {
  await client.signIn.social({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' });
}

export async function signOut(): Promise<void> {
  await client.signOut();
  window.location.reload();
}
