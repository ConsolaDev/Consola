const NEEDS_VERIFIED_EMAIL = 'Consola Cloud needs a Google account with a verified email address.';

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
