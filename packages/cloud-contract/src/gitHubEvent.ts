import { fieldProblem, isId, isRecord, isWholeNumber, read, refused } from './read.js';
import type { ReadResult } from './read.js';
import { isRegion } from './region.js';
import type { Region } from './region.js';

/**
 * How `cloud-global` passes one of GitHub's webhook events on to the cell of the workspace that
 * holds the installation it came through, and what the cell answers.
 *
 * `cloud-global` receives the GitHub App's webhooks, checks GitHub's signature and finds the
 * workspace from the event's installation, and keeps nothing of the event: what happens in a
 * company's repositories is the company's, so it is kept in the workspace's region, by its cell.
 * A delivery is one `POST` to `GITHUB_EVENT_DELIVERY_PATH` on the cell's origin, carrying one
 * event. Its body is the event's message as JSON, signed as an outbox delivery is: a JWS in
 * compact serialization (RFC 7515), sent as `GITHUB_EVENT_DELIVERY_MEDIA_TYPE`, signed with the
 * key that signs cell tokens (`CELL_TOKEN_ALGORITHM`, the key's `kid`). The header's `typ` is
 * `GITHUB_EVENT_TYPE`, which neither an outbox message nor a cell token carries, and the cell
 * refuses any other, so none of the three passes for another.
 */
export const GITHUB_EVENT_DELIVERY_PATH = '/api/github/events';

/** The media type of a delivery's body: a JWS in compact serialization (RFC 7515). */
export const GITHUB_EVENT_DELIVERY_MEDIA_TYPE = 'application/jose';

/** The `typ` in a delivery's protected header. */
export const GITHUB_EVENT_TYPE = 'consola-github-event';

/**
 * The most GitHub puts in one webhook delivery's body: it delivers no event whose payload would be
 * larger (25 MB).
 */
export const GITHUB_PAYLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The most a cell takes in one delivery's body: any payload GitHub sends, as a compact JWS, whose
 * base64url spends four characters on every three bytes, with room for the message's other
 * fields, the header and the signature.
 */
export const GITHUB_EVENT_DELIVERY_MAX_BYTES = 36 * 1024 * 1024;

/**
 * What a cell answers a delivery, by status. A 2xx says the cell has the event: `recorded` now,
 * or `recordedBefore`, when it had one with the same delivery id for the workspace already and
 * changed nothing. GitHub keeps a delivery's id when it delivers it again, so an event is
 * recorded once however often it arrives, and `cloud-global` tells GitHub a delivery it had
 * passed on already is a duplicate.
 */
export const GITHUB_EVENT_ANSWER = {
  /** The cell recorded the event now. */
  recorded: 201,
  /** The cell had recorded the event already: a delivery sent again. Nothing changed. */
  recordedBefore: 200,
  /** The body is no event the contract reads, or is not sent as a signed event. */
  unreadable: 400,
  /**
   * The signature is not `cloud-global`'s: not a compact JWS, another algorithm or `typ`, no
   * `kid`, a key the set does not hold, or a signature that does not check.
   */
  unsigned: 401,
  /**
   * The cell holds nothing of the workspace yet: its outbox's `workspace.created` has not
   * arrived. Sending the event again once it has helps.
   */
  workspacePending: 409,
  /** The event is for a workspace in another region. */
  otherRegion: 421,
  /** The cell could not get `cloud-global`'s keys, or could not reach its own database. */
  unavailable: 503,
} as const;

/** One of GitHub's webhook events, as `cloud-global` passes it on to a workspace's cell. */
export type GitHubEventMessage = {
  /** The id in `cloud-global` of the workspace that holds the installation. */
  workspaceId: string;
  /** The workspace's region. A cell refuses an event for a workspace in another region. */
  region: Region;
  /**
   * GitHub's id of the delivery (`X-GitHub-Delivery`), which it keeps when the delivery is sent
   * again: a cell records a workspace's event once by it.
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

const ENVELOPE = [
  'workspaceId',
  'region',
  'deliveryId',
  'event',
  'installationId',
  'payload',
] as const;

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
 * Reads an event's message as it arrives at a cell, once its signature has been checked (JSON,
 * parsed). It refuses any other shape: a field missing, or one the contract does not name, a
 * region it does not list, an id or a name that is not GitHub's, and a payload that is not an
 * object about the installation the message names. Whether the region is the cell's own is the
 * cell's to check.
 */
export function readGitHubEventMessage(value: unknown): ReadResult<GitHubEventMessage> {
  if (!isRecord(value)) return refused('the message is not an object');
  const fields = fieldProblem(value, ENVELOPE, 'the message');
  if (fields !== null) return refused(fields);

  const { workspaceId, region, deliveryId, event, installationId, payload } = value;
  if (!isId(workspaceId)) return refused("`workspaceId` is not a workspace's id");
  if (!isRegion(region)) return refused('`region` is not a region');
  if (!isGitHubDeliveryId(deliveryId)) {
    return refused("`deliveryId` is not GitHub's id of a delivery");
  }
  if (!isGitHubEventName(event)) {
    return refused("`event` is not the name of one of GitHub's events");
  }
  if (!isWholeNumber(installationId) || installationId < 1) {
    return refused('`installationId` is not a whole number from 1');
  }
  if (!isRecord(payload)) return refused('`payload` is not an object');
  const { installation } = payload;
  if (!isRecord(installation) || installation.id !== installationId) {
    return refused('`payload.installation.id` is not `installationId`');
  }
  return read({ workspaceId, region, deliveryId, event, installationId, payload });
}
