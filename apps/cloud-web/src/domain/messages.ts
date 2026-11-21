const NEEDS_VERIFIED_EMAIL = 'Consola Cloud needs a Google account with a verified email address.';

/** The sentence for a sign-in or sign-out call that failed, resolved with an error or thrown. */
export function messageForActionFailure(failure: unknown): string {
  const status =
    typeof failure === 'object' && failure !== null && 'status' in failure
      ? failure.status
      : undefined;
  if (status === 429) return 'Too many sign-in attempts. Wait a minute and try again.';
  return 'Consola Cloud’s service isn’t answering. Try again in a moment.';
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
