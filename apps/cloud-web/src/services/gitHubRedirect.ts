import { readGitHubReturn } from '../domain/connections';
import type { GitHubReturn } from '../domain/connections';

/**
 * What the API's GitHub callback sent the page back with, read once: how the last Connect ended
 * (`?github=`), or the choice of installation it waits on (`?github=choose&choice=`). It removes
 * `github` and `choice` from the address and keeps the rest, the page's
 * `#/settings/connections` included, so a reload does not say it, or offer it, again.
 */
export function takeGitHubReturn(): GitHubReturn | null {
  const url = new URL(window.location.href);
  const { searchParams } = url;
  if (!searchParams.has('github') && !searchParams.has('choice')) return null;
  const returned = readGitHubReturn(searchParams.get('github'), searchParams.get('choice'));
  searchParams.delete('github');
  searchParams.delete('choice');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return returned;
}

/** Sends the person to GitHub to sign in or install the app, from where GitHub sends them back. */
export function goToGitHub(url: string): void {
  window.location.assign(url);
}
