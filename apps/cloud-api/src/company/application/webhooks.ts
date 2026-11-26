import type { GitHubEventMessage } from '@consola/cloud-contract';
import type { Region } from '../../shared/region.js';
import { installationOfEvent, PING_EVENT, readDeliveryHeaders } from '../domain/webhooks.js';
import type {
  CellEvents,
  GitHubEventSigner,
  InstallationStore,
  WebhookSignatures,
} from './ports.js';

/** One webhook delivery, as GitHub sent it: the body's bytes and the headers that matter. */
export type WebhookDelivery = {
  /** The body exactly as it arrived: the signature is over these bytes. */
  body: Uint8Array;
  /** `X-Hub-Signature-256`. */
  signature: string | undefined;
  /** `X-GitHub-Event`. */
  event: string | undefined;
  /** `X-GitHub-Delivery`. */
  deliveryId: string | undefined;
};

/** Which delivery, as GitHub names it: read only from one whose signature checked. */
export type DeliveryNames = { deliveryId: string; event: string };

/** Where a delivery's event goes: the installation it came through, and who holds it. */
export type Passing = { installationId: number; workspaceId: string; region: Region };

/** What became of one delivery, in the order it is checked. */
export type WebhookOutcome =
  /** No webhook secret is set, so no delivery can be checked: every one is refused. */
  | { kind: 'not-configured' }
  /** The signature is missing, or not GitHub's over this body: nothing else was read. */
  | { kind: 'bad-signature' }
  /** Signed, but a header or the body is not what GitHub sends. `reason` names which. */
  | { kind: 'invalid'; reason: string }
  /** GitHub's ping, as a webhook is set up: answered, and passed on to no cell. */
  | { kind: 'ping'; delivery: DeliveryNames }
  /** An event that came through no installation, so no workspace's: dropped. */
  | { kind: 'no-installation'; delivery: DeliveryNames }
  /** An event through an installation no workspace holds: dropped. */
  | { kind: 'unknown-installation'; delivery: DeliveryNames; installationId: number }
  /** The workspace's region has no cell configured, so the event could not be passed on. */
  | { kind: 'no-cell'; delivery: DeliveryNames; passing: Passing }
  /** The cell did not take the event: a refusal, no answer, or no connection. */
  | { kind: 'failed'; delivery: DeliveryNames; passing: Passing; error: string }
  /** The cell had this delivery already: sent again by GitHub, or replayed. Nothing changed. */
  | { kind: 'duplicate'; delivery: DeliveryNames; passing: Passing }
  /** The workspace's cell recorded the event. */
  | { kind: 'delivered'; delivery: DeliveryNames; passing: Passing };

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The body as an object, as every one of GitHub's payloads is, or why it is not one. */
function readBody(
  body: Uint8Array,
): { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(body));
  } catch {
    return { ok: false, reason: 'its body is not JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'its body is not a JSON object' };
  }
  return { ok: true, payload: value as Record<string, unknown> };
}

/**
 * Receives one of the GitHub App's webhook deliveries and passes its event on to the cell of the
 * workspace that holds the installation it came through, keeping nothing of it here: what
 * happens in a company's repositories is the company's, so it lives in the workspace's region.
 *
 * The signature comes first: until GitHub's `X-Hub-Signature-256` checks against the body's
 * bytes, nothing else is read, so a forged delivery reaches no header, no parser and no store.
 * Then the headers and the body, GitHub's ping (answered, passed on to no cell), the
 * installation and the workspace that holds it (an event through none, or through one no
 * workspace holds, is dropped), and the cell, which records each delivery once by its id: a
 * delivery it had already, sent again or replayed, is a `duplicate`, and changes nothing.
 */
export async function receiveGitHubWebhook(
  ports: {
    /** Null when no webhook secret is set. */
    signatures: WebhookSignatures | null;
    installations: InstallationStore;
    signer: GitHubEventSigner;
    cells: CellEvents;
  },
  sent: WebhookDelivery,
): Promise<WebhookOutcome> {
  const { signatures, installations, signer, cells } = ports;
  if (signatures === null) return { kind: 'not-configured' };
  if (!signatures.verify(sent.body, sent.signature)) return { kind: 'bad-signature' };

  const headers = readDeliveryHeaders({ event: sent.event, deliveryId: sent.deliveryId });
  if (!headers.ok) return { kind: 'invalid', reason: headers.reason };
  const delivery: DeliveryNames = { deliveryId: headers.deliveryId, event: headers.event };
  const body = readBody(sent.body);
  if (!body.ok) return { kind: 'invalid', reason: body.reason };

  if (delivery.event === PING_EVENT) return { kind: 'ping', delivery };

  const installationId = installationOfEvent(body.payload);
  if (installationId === null) return { kind: 'no-installation', delivery };
  const holder = await installations.holderOf(installationId);
  if (holder === null) return { kind: 'unknown-installation', delivery, installationId };

  const passing: Passing = { installationId, ...holder };
  if (!cells.reaches(holder.region)) return { kind: 'no-cell', delivery, passing };

  const event: GitHubEventMessage = {
    workspaceId: holder.workspaceId,
    region: holder.region,
    deliveryId: delivery.deliveryId,
    event: delivery.event,
    installationId,
    payload: body.payload,
  };
  const answer = await cells.pass(holder.region, await signer.signGitHubEvent(event));
  if (answer.kind === 'recorded') return { kind: 'delivered', delivery, passing };
  if (answer.kind === 'recorded-before') return { kind: 'duplicate', delivery, passing };
  return { kind: 'failed', delivery, passing, error: answer.error };
}
