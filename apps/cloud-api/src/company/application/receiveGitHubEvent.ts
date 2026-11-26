import { readGitHubEventMessage } from '@consola/cloud-contract';
import type { GitHubEventMessage, ReadResult } from '@consola/cloud-contract';
import type { Region } from '../domain/region.js';
import { startAgentRunsFor } from './agentRuns.js';
import type { AgentRunPorts, DeliveryVerifier, GitHubEventStore } from './ports.js';
import { readJsonPayload, whatFailed } from './signedPayload.js';

/** What the cell makes of one GitHub event `cloud-global` passed on, in the order it checks. */
export type GitHubEventAnswer =
  /**
   * The cell has the event: this delivery recorded it (`now`), or the cell had recorded one with
   * its delivery id for the workspace before, and the delivery changed nothing.
   */
  | { kind: 'recorded'; event: GitHubEventMessage; now: boolean }
  /** The delivery is not signed by `cloud-global` as an event. */
  | { kind: 'unsigned'; reason: string }
  /** Signed, but its payload is no event the contract reads. */
  | { kind: 'unreadable'; reason: string }
  /** An event for a workspace in another region, which this cell does not serve. */
  | { kind: 'other-region'; event: GitHubEventMessage }
  /** The cell holds nothing of the workspace yet: its `workspace.created` is not applied. */
  | { kind: 'workspace-pending'; event: GitHubEventMessage }
  /** `cloud-global`'s keys could not be had, so the delivery could not be checked. */
  | { kind: 'keys-unavailable' }
  /** The cell's database did not answer, so the event was not recorded. */
  | { kind: 'database-unavailable'; event: GitHubEventMessage; reason: string };

/** Reads a checked payload: UTF-8 text, JSON, then an event the contract reads. */
function readPayload(payload: Uint8Array): ReadResult<GitHubEventMessage> {
  const json = readJsonPayload(payload);
  return json.ok ? readGitHubEventMessage(json.value) : json;
}

/**
 * Receives one GitHub event `cloud-global` passed on, `delivery` being its body, for the cell
 * serving `cellRegion`. It checks, in the contract's order, that `cloud-global` signed it as an
 * event, that its payload is an event the contract reads and that its workspace is in this
 * cell's region, then records it for the workspace, once by its delivery id: an event the cell
 * has already changes nothing. The cell keeps it for the workspace's runners and triggers, which
 * come later (epics 21 and 39).
 *
 * An event recorded now, and only then, starts the agent runs it fires (`startAgentRunsFor`),
 * when `agentRuns` is given. Whatever goes wrong there is logged through its `report`, ids and
 * names only, and never changes the answer: the event is recorded either way.
 */
export async function receiveGitHubEvent(
  ports: { events: DeliveryVerifier; gitHubEvents: GitHubEventStore; agentRuns?: AgentRunPorts },
  cellRegion: Region,
  delivery: string,
): Promise<GitHubEventAnswer> {
  const signature = await ports.events.verify(delivery);
  if (signature.kind !== 'verified') return signature;

  const read = readPayload(signature.payload);
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };
  const event = read.value;

  if (event.region !== cellRegion) return { kind: 'other-region', event };

  let recorded: Awaited<ReturnType<GitHubEventStore['record']>>;
  try {
    recorded = await ports.gitHubEvents.record(event);
  } catch (error) {
    return { kind: 'database-unavailable', event, reason: whatFailed(error) };
  }
  if (recorded === 'workspace-pending') return { kind: 'workspace-pending', event };
  if (recorded === 'recorded' && ports.agentRuns) {
    try {
      await startAgentRunsFor(ports.agentRuns, event);
    } catch (error) {
      ports.agentRuns.report(
        `GitHub delivery ${event.deliveryId} (${event.event}) for workspace ${event.workspaceId} started no agent run: ${whatFailed(error)}`,
      );
    }
  }
  return { kind: 'recorded', event, now: recorded === 'recorded' };
}
