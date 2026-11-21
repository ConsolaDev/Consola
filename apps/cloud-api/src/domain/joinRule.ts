/**
 * Who may sign in here: anyone whose Google email is verified. It is checked before an account is
 * created and before every new session, so a domain or invitation rule added here gates every
 * sign-in. Sessions already open when the rule changes are not ended by it.
 */
export function mayJoin(user: { emailVerified: boolean }): boolean {
  return user.emailVerified;
}
