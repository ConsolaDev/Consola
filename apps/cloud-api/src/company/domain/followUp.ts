import { readFollowUp } from '@consola/runner-protocol';
import type { FollowUp, ReadResult } from '@consola/runner-protocol';
import { isAgentRun } from './cloudSession.js';
import type { CloudSession } from './cloudSession.js';

/**
 * A follow-up: a person's message for a running agent run's orchestrator, such as a reply in the
 * Slack thread the run answers in. The app sends it straight to the session's host, which fences
 * it, says who wrote it and queues it after the orchestrator's turn, once: the same follow-up sent
 * again under its key is the one before (`@consola/runner-protocol`, "Follow-ups"). These are the
 * rules the app keeps about one.
 */

/**
 * Who wrote a follow-up: the person, by id, and the caller's words for them, such as `a teammate
 * in Slack`. A label, never a name: the app keeps no person's name.
 */
export type FollowUpAuthor = { personId: string; label: string };

/** A follow-up as a caller hands it over: its key (a Slack event's id, say), text and author. */
export type FollowUpRequest = { key: string; text: string; author: FollowUpAuthor };

/** How long a follow-up's pass lives: the one call to the host, with room for a slow answer. */
export const FOLLOW_UP_PASS_SECONDS = 60;

/**
 * What the host is sent for a follow-up (the protocol's `FollowUp`, read by its own reader, as
 * the host reads it), or why it cannot be sent. The person travels in the pass, never here.
 */
export function followUpBody(request: FollowUpRequest): ReadResult<FollowUp> {
  if (request.author.personId === '') {
    return { ok: false, reason: "the author's person id is empty" };
  }
  return readFollowUp({
    key: request.key,
    text: request.text,
    authorLabel: request.author.label,
  });
}

/**
 * Where a session stands for a follow-up: its host is there to take one (`host`); it is an agent
 * run still on its way up (`starting`: no `running`, or no host address yet); or there is no
 * agent run of the workspace running under that id (`not_running`: ended, another workspace's, a
 * person's session, or none).
 */
export type FollowUpReach =
  | { kind: 'host'; hostUrl: string }
  | { kind: 'starting' }
  | { kind: 'not_running' };

export function followUpReach(session: CloudSession | null, workspaceId: string): FollowUpReach {
  if (session === null || session.workspaceId !== workspaceId || !isAgentRun(session)) {
    return { kind: 'not_running' };
  }
  if (session.status === 'starting') return { kind: 'starting' };
  if (session.status !== 'running') return { kind: 'not_running' };
  return session.hostUrl === null
    ? { kind: 'starting' }
    : { kind: 'host', hostUrl: session.hostUrl };
}
