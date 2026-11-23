import { isGitHubDeliveryId, isGitHubEventName } from '@consola/cloud-contract';

/**
 * The event GitHub sends when an app's webhook is set up or changed, to see that it answers. It
 * is about no installation, so it is answered and never passed on.
 */
export const PING_EVENT = 'ping';

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
