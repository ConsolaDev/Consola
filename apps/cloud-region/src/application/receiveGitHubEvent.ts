import { readGitHubEventMessage } from '@consola/cloud-contract';
import type { GitHubEventMessage, ReadResult } from '@consola/cloud-contract';
import { handOverOf, repositoryOfPayload } from '../domain/gitHubEvent.js';
import type { Region } from '../domain/region.js';
import type { DeliveryVerifier, GitHubEventStore, RunnerChannel } from './ports.js';
import { readJsonPayload, whatFailed } from './signedPayload.js';

/** What the cell makes of one GitHub event `cloud-global` passed on, in the order it checks. */
export type GitHubEventAnswer =
  /**
   * The cell has the event: this delivery recorded it (`now`), or the cell had recorded one with
   * its delivery id for the workspace before, and the delivery changed nothing. `runner` says
   * what became of it for the workspace's runner, this time: `handed` to it, `held` for its next
   * hello, `not-for-runners` with why (it did not read into facts), or null (no runner takes it,
   * or it was recorded before).
   */
  | { kind: 'recorded'; event: GitHubEventMessage; now: boolean; runner: RunnerOutcome }
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

/** What became of a recorded event for the workspace's runner (above). */
export type RunnerOutcome =
  | { kind: 'handed' }
  | { kind: 'held' }
  | { kind: 'not-for-runners'; reason: string }
  | null;

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
 * has already changes nothing.
 *
 * A pull request's event is recorded held for the workspace's runner, with its facts
 * (`handOverOf`), and handed to the runner when this delivery recorded it and a runner that runs
 * automations is connected; otherwise its next hello gets it. So an event GitHub delivers twice
 * is handed once. One whose payload does not read into facts is recorded as not for runners, and
 * never handed.
 */
export async function receiveGitHubEvent(
  ports: {
    events: DeliveryVerifier;
    gitHubEvents: GitHubEventStore;
    runners: Pick<RunnerChannel, 'handEvent'>;
  },
  cellRegion: Region,
  delivery: string,
): Promise<GitHubEventAnswer> {
  const signature = await ports.events.verify(delivery);
  if (signature.kind !== 'verified') return signature;

  const read = readPayload(signature.payload);
  if (!read.ok) return { kind: 'unreadable', reason: read.reason };
  const event = read.value;

  if (event.region !== cellRegion) return { kind: 'other-region', event };

  const handOver = handOverOf(event.event, event.payload);
  let recorded: Awaited<ReturnType<GitHubEventStore['record']>>;
  try {
    recorded = await ports.gitHubEvents.record(event, {
      handOver,
      repository: repositoryOfPayload(event.payload),
    });
  } catch (error) {
    return { kind: 'database-unavailable', event, reason: whatFailed(error) };
  }
  if (recorded === 'workspace-pending') return { kind: 'workspace-pending', event };
  if (recorded === 'recorded-before' || handOver === null) {
    return { kind: 'recorded', event, now: recorded === 'recorded', runner: null };
  }
  if (handOver.kind === 'not-for-runners') {
    return { kind: 'recorded', event, now: true, runner: handOver };
  }
  const handed = ports.runners.handEvent(event.workspaceId, {
    deliveryId: event.deliveryId,
    facts: handOver.facts,
  });
  return { kind: 'recorded', event, now: true, runner: { kind: handed ? 'handed' : 'held' } };
}
