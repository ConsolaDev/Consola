/**
 * Who may create an account here: anyone whose Google email is verified. A domain or invitation
 * rule, when one is wanted, lands in this one function.
 */
export function mayJoin(user: { emailVerified: boolean }): boolean {
  return user.emailVerified;
}
