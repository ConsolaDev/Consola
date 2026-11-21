import { mayJoin } from '../domain/joinRule.js';
import type { PeopleStore } from './ports.js';

/** Whether an account may be created for this person: `mayJoin`, before the account exists. */
export function mayCreateAccount(person: { emailVerified: boolean }): boolean {
  return mayJoin(person);
}

/**
 * Whether a person may get a new session: `mayJoin` again, on what is stored now, so someone
 * whose email is no longer verified is turned away. A person who does not exist may not.
 */
export async function mayStartSession(people: PeopleStore, userId: string): Promise<boolean> {
  const emailVerified = await people.emailVerified(userId);
  if (emailVerified === null) return false;
  return mayJoin({ emailVerified });
}
