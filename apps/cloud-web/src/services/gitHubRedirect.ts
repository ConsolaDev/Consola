import { type GitHubResult, readGitHubResult } from '../domain/connections';

/**
 * How the last Connect ended, as `cloud-global`'s callback named it in `?github=`, read once. It
 * removes `github` from the address and keeps the rest, the page's `#/settings/connections` included,
 * so a reload does not say it again.
 */
export function takeGitHubResult(): GitHubResult | 'unknown' | null {
  const url = new URL(window.location.href);
  const result = readGitHubResult(url.searchParams.get('github'));
  if (result === null) return null;
  url.searchParams.delete('github');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return result;
}

/** Sends the person to GitHub to install the app, from where GitHub sends them back. */
export function goToGitHub(url: string): void {
  window.location.assign(url);
}
