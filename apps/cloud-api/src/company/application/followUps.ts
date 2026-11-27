import { passClaims } from '@consola/runner-protocol';
import { FOLLOW_UP_PASS_SECONDS, followUpBody, followUpReach } from '../domain/followUp.js';
import type { FollowUpRequest } from '../domain/followUp.js';
import type { FollowUpPorts } from './ports.js';

export type { FollowUpAuthor, FollowUpRequest } from '../domain/followUp.js';

/**
 * What became of a follow-up:
 *
 * - `delivered`: the orchestrator's conversation has it now, queued after its turn;
 * - `already_delivered`: the same follow-up (its key, author and text) had reached it before,
 *   and this one changed nothing. Other words or another author under a used key are a follow-up
 *   of their own, delivered;
 * - `starting`: the run is on its way up (no host address yet, or its first message not yet
 *   sent). Nothing was delivered; the same follow-up may be sent again shortly;
 * - `not_running`: no agent run of the workspace runs under that id: it ended (its sandbox
 *   stopped included), or it is another workspace's, a person's session, or none. What picks
 *   an ended run up again is CON-39's and 41.8's to decide, not this;
 * - `host_unreachable`: the host could not be reached, or did not take it, or the app has no pass
 *   key to reach a host with. Nothing is known to be delivered; sending it again is safe;
 * - `invalid`: the follow-up is not one the host would read (`reason` names the field).
 */
export type FollowUpAnswer =
  | { kind: 'delivered' }
  | { kind: 'already_delivered' }
  | { kind: 'starting' }
  | { kind: 'not_running' }
  | { kind: 'host_unreachable' }
  | { kind: 'invalid'; reason: string };

/**
 * Hands a running agent run's orchestrator a person's follow-up, exactly once however often the
 * same follow-up is sent under its `key`: the host queues it after the orchestrator's turn,
 * fenced, saying who wrote it, keyed by the key and the message it becomes
 * (`packages/host/AGENTS.md`, "Agent runs").
 *
 * The app signs a pass for the author (`sub`) in the session's workspace, for
 * `FOLLOW_UP_PASS_SECONDS`, and sends it with the follow-up straight to the session's host, at
 * the address its runner reported; no runner relays it. Whether the author may talk to the run
 * (a member who sees its factory, say) is the caller's to decide first: this checks only that the
 * session is a running agent run of `workspaceId`. Throws only when the sessions cannot be read
 * or the pass cannot be signed.
 */
export async function sendFollowUp(
  ports: FollowUpPorts,
  target: { workspaceId: string; sessionId: string },
  request: FollowUpRequest,
): Promise<FollowUpAnswer> {
  const body = followUpBody(request);
  if (!body.ok) return { kind: 'invalid', reason: body.reason };

  const reach = followUpReach(await ports.sessions.find(target.sessionId), target.workspaceId);
  if (reach.kind !== 'host') return { kind: reach.kind };
  if (!ports.passes) return { kind: 'host_unreachable' };

  const claims = passClaims({
    personId: request.author.personId,
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    issuedAt: ports.clock.nowSeconds(),
    lifetimeSeconds: FOLLOW_UP_PASS_SECONDS,
  });
  const pass = await ports.passes.sign(claims);
  switch (await ports.hosts.sendFollowUp(reach.hostUrl, pass, body.value)) {
    case 'delivered':
      return { kind: 'delivered' };
    case 'already-delivered':
      return { kind: 'already_delivered' };
    case 'not-ready':
      return { kind: 'starting' };
    case 'not-here':
      return { kind: 'not_running' };
    case 'failed':
      return { kind: 'host_unreachable' };
  }
}
