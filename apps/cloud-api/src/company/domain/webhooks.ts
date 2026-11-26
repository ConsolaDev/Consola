/**
 * The event GitHub sends when an app's webhook is set up or changed, to see that it answers. It
 * is about no installation, so it is answered and never recorded.
 */
export const PING_EVENT = 'ping';

/**
 * The most GitHub puts in one webhook delivery's body: it delivers no event whose payload would
 * be larger (25 MB).
 */
export const GITHUB_PAYLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * GitHub's id of a delivery: a GUID, read as letters, digits and dashes, at most 64 of them, so
 * that nothing else (a space, a line break, a path) can ride along where it is logged or kept.
 */
export function isGitHubDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

/** The name of one of GitHub's events: lowercase letters, digits and underscores. */
export function isGitHubEventName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
}

/**
 * One of GitHub's webhook events, for the workspace that holds the installation it came through,
 * as it is recorded: only once its delivery's signature checked and its headers read.
 */
export type GitHubEvent = {
  /** The workspace that holds the installation. */
  workspaceId: string;
  /**
   * GitHub's id of the delivery (`X-GitHub-Delivery`), which it keeps when the delivery is sent
   * again: a workspace's event is recorded once by it.
   */
  deliveryId: string;
  /** The event's name (`X-GitHub-Event`): `pull_request`, `push`, `installation`, … */
  event: string;
  /** The installation of Consola's GitHub App the event came through. */
  installationId: number;
  /**
   * The event's payload, as GitHub sent it. Its shape is GitHub's, so it is read as an object
   * about `installationId`, and no further.
   */
  payload: Record<string, unknown>;
};

/**
 * What GitHub's headers say a signed delivery is: the event's name (`X-GitHub-Event`) and
 * GitHub's id of the delivery (`X-GitHub-Delivery`), which it keeps when it sends the delivery
 * again. A header missing, or not one GitHub writes, is refused, naming the header and never what
 * it held, so the reason can be logged.
 */
export function readDeliveryHeaders(headers: {
  event?: string;
  deliveryId?: string;
}): { ok: true; event: string; deliveryId: string } | { ok: false; reason: string } {
  const { event, deliveryId } = headers;
  if (event === undefined) return { ok: false, reason: 'it has no X-GitHub-Event' };
  if (!isGitHubEventName(event)) {
    return { ok: false, reason: "its X-GitHub-Event is not the name of one of GitHub's events" };
  }
  if (deliveryId === undefined) return { ok: false, reason: 'it has no X-GitHub-Delivery' };
  if (!isGitHubDeliveryId(deliveryId)) {
    return { ok: false, reason: "its X-GitHub-Delivery is not GitHub's id of a delivery" };
  }
  return { ok: true, event, deliveryId };
}

/**
 * The installation of Consola's GitHub App an event came through, as its payload names it
 * (`installation.id`), or null when it names none GitHub would: an app's own events, such as a
 * person revoking its authorisation, come through no installation.
 */
export function installationOfEvent(payload: Record<string, unknown>): number | null {
  const { installation } = payload;
  if (typeof installation !== 'object' || installation === null) return null;
  const { id } = installation as { id?: unknown };
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 1 ? id : null;
}
