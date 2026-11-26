import { installationOfEvent, PING_EVENT, readDeliveryHeaders } from '../domain/webhooks.js';
import type { GitHubEvent } from '../domain/webhooks.js';
import { startAgentRunsFor } from './agentRuns.js';
import type { GitHubEventStore, InstallationStore, WebhookSignatures } from './gitHubPorts.js';
import type { AgentRunPorts } from './ports.js';

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

/** Whose a delivery's event is: the installation it came through, and the workspace holding it. */
export type Holding = { installationId: number; workspaceId: string };

/** What became of one delivery, in the order it is checked. */
export type WebhookOutcome =
  /** No webhook secret is set, so no delivery can be checked: every one is refused. */
  | { kind: 'not-configured' }
  /** The signature is missing, or not GitHub's over this body: nothing else was read. */
  | { kind: 'bad-signature' }
  /** Signed, but a header or the body is not what GitHub sends. `reason` names which. */
  | { kind: 'invalid'; reason: string }
  /** GitHub's ping, as a webhook is set up: answered, and recorded for no workspace. */
  | { kind: 'ping'; delivery: DeliveryNames }
  /** An event that came through no installation, so no workspace's: dropped. */
  | { kind: 'no-installation'; delivery: DeliveryNames }
  /** An event through an installation no workspace holds: dropped. */
  | { kind: 'unknown-installation'; delivery: DeliveryNames; installationId: number }
  /** The workspace had this delivery already: sent again by GitHub, or replayed. Nothing changed. */
  | { kind: 'duplicate'; delivery: DeliveryNames; holding: Holding }
  /** The event is recorded for the workspace that holds its installation, by this delivery. */
  | { kind: 'recorded'; delivery: DeliveryNames; holding: Holding }
  /**
   * The database did not answer, so the event was not recorded. `reason` is what failed, never
   * the query or the event; GitHub's Redeliver sends the delivery again.
   */
  | { kind: 'unavailable'; delivery: DeliveryNames; reason: string };

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

/** The innermost cause's first line: what failed, without the query that failed. */
function whatFailed(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    current instanceof Error && current.cause !== undefined && depth < 5;
    depth++
  ) {
    current = current.cause;
  }
  const line = current instanceof Error ? current.message.split('\n')[0]?.trim() : undefined;
  return line || 'an unexpected error';
}

/**
 * Records one GitHub event for its workspace, once by its delivery id: an event the workspace
 * has already changes nothing (`now` false). The workspace keeps it for its runners and
 * triggers, which come later (epics 21 and 39).
 *
 * An event recorded now, and only then, starts the agent runs it fires (`startAgentRunsFor`),
 * when `agentRuns` is given. Whatever goes wrong there is logged through its `report`, ids and
 * names only, and never changes the answer: the event is recorded either way. A database that
 * does not answer is `unavailable`, never thrown.
 */
export async function recordGitHubEvent(
  ports: { events: GitHubEventStore; agentRuns?: AgentRunPorts },
  event: GitHubEvent,
): Promise<{ kind: 'recorded'; now: boolean } | { kind: 'unavailable'; reason: string }> {
  let recorded: Awaited<ReturnType<GitHubEventStore['record']>>;
  try {
    recorded = await ports.events.record(event);
  } catch (error) {
    return { kind: 'unavailable', reason: whatFailed(error) };
  }
  const now = recorded === 'recorded';
  if (now && ports.agentRuns) {
    try {
      await startAgentRunsFor(ports.agentRuns, event);
    } catch (error) {
      ports.agentRuns.report(
        `GitHub delivery ${event.deliveryId} (${event.event}) for workspace ${event.workspaceId} started no agent run: ${whatFailed(error)}`,
      );
    }
  }
  return { kind: 'recorded', now };
}

/**
 * Receives one of the GitHub App's webhook deliveries and records its event for the workspace
 * that holds the installation it came through: what happens in a company's repositories is the
 * company's, kept for its runners and triggers.
 *
 * The signature comes first: until GitHub's `X-Hub-Signature-256` checks against the body's
 * bytes, nothing else is read, so a forged delivery reaches no header, no parser and no store.
 * Then the headers and the body, GitHub's ping (answered, recorded for no workspace), the
 * installation and the workspace that holds it (an event through none, or through one no
 * workspace holds, is dropped), and the record, once per workspace and delivery id: a delivery
 * the workspace had already, sent again or replayed, is a `duplicate`, and changes nothing. An
 * event recorded now starts the agent runs it fires (`recordGitHubEvent`), which never changes
 * the outcome. A database that does not answer, for the holder or the record, is `unavailable`.
 */
export async function receiveGitHubWebhook(
  ports: {
    /** Null when no webhook secret is set. */
    signatures: WebhookSignatures | null;
    installations: InstallationStore;
    events: GitHubEventStore;
    agentRuns?: AgentRunPorts;
  },
  sent: WebhookDelivery,
): Promise<WebhookOutcome> {
  const { signatures, installations } = ports;
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
  let workspaceId: string | null;
  try {
    workspaceId = await installations.holderOf(installationId);
  } catch (error) {
    return { kind: 'unavailable', delivery, reason: whatFailed(error) };
  }
  if (workspaceId === null) return { kind: 'unknown-installation', delivery, installationId };

  const holding: Holding = { installationId, workspaceId };
  const recorded = await recordGitHubEvent(
    { events: ports.events, agentRuns: ports.agentRuns },
    { ...delivery, workspaceId, installationId, payload: body.payload },
  );
  if (recorded.kind === 'unavailable') {
    return { kind: 'unavailable', delivery, reason: recorded.reason };
  }
  return recorded.now
    ? { kind: 'recorded', delivery, holding }
    : { kind: 'duplicate', delivery, holding };
}
