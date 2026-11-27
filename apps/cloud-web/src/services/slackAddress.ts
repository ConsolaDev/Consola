import { readSlackResult, slackLinkTokenOfHash } from '../domain/slack';
import type { SlackResult } from '../domain/slack';

/*
 * Slack's places in the address bar (CON-144). The one-time link page is the hash
 * `#/slack/link/<token>`, which the bot sends in Slack, read like Settings' and Runs' places
 * (`settingsAddress.ts`, `runsAddress.ts`). How "Add to Slack" ended is `?slack=<result>` before
 * the hash, which the API's callback sends the person back with, read once and cleared, as
 * GitHub's `?github=` is (`gitHubRedirect.ts`).
 */

/** The token of the link page the address names, or null when it names none. */
export function currentSlackLinkToken(): string | null {
  return slackLinkTokenOfHash(window.location.hash);
}

/**
 * Hears every change of the address, a link followed or back and forward included, with the
 * link page's token it names now. Returns what stops it.
 */
export function onSlackLinkChange(listener: (token: string | null) => void): () => void {
  const heard = () => listener(currentSlackLinkToken());
  window.addEventListener('hashchange', heard);
  return () => window.removeEventListener('hashchange', heard);
}

/**
 * Leaves the link page for the dashboard, in place of it in the history: back does not return to
 * a link that has done its work.
 */
export function leaveSlackLink(): void {
  window.location.replace('#/');
}

/**
 * How the last "Add to Slack" ended, as the API's callback named it in `?slack=`, read once. It
 * removes `slack` from the address and keeps the rest, the factory's settings in the hash
 * included, so a reload does not say it again.
 */
export function takeSlackResult(): SlackResult | 'unknown' | null {
  const url = new URL(window.location.href);
  const result = readSlackResult(url.searchParams.get('slack'));
  if (result === null) return null;
  url.searchParams.delete('slack');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return result;
}

/** Sends the person to Slack (its authorise page), from where Slack sends them back. */
export function goToSlack(url: string): void {
  window.location.assign(url);
}
