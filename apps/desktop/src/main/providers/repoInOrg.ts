/**
 * Whether `repo` (`owner/name`) is inside the organization a workspace's
 * provider binding names: any repository when it names none (the binding's
 * `org` is absent), else one that organization owns, whatever the casing of
 * either.
 */
export function repoInOrg(repo: string, org: string | undefined): boolean {
  return !org || repo.split('/')[0].toLowerCase() === org.toLowerCase();
}
