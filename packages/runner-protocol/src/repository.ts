/** A repository as `owner/name`, the way a runner offers it and a session asks for it. */
export type Repository = string;

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * `owner/name`. The name may not be `.` or `..` or start with `.`, so a repository can never name
 * a path above the folder it is cloned into, nor `.git`.
 */
export function isRepository(value: unknown): value is Repository {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) return false;
  return !(value.split('/')[1] ?? '.').startsWith('.');
}
