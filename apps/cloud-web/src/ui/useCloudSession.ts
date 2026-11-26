import { useRef, useState } from 'react';
import {
  chatMounted,
  keepsShownOn,
  sessionPollIntervalMs,
  shouldRenewPass,
} from '../domain/cloudSession';
import type { CloudSession, SessionAnswer } from '../domain/cloudSession';
import { messageForPassAnswer } from '../domain/cloudSessionMessages';
import type { MyWorkspace } from '../domain/workspace';
import { cloudSessionsService } from '../services/cloudSessions';
import { usePoll } from './usePoll';

/** What reading one cloud session came to: not yet, the session, or why there is none. */
export type SessionView =
  | { kind: 'loading' }
  | { kind: 'shown'; session: CloudSession; failedAt: string | null }
  | { kind: 'refused'; answer: Exclude<SessionAnswer, { kind: 'found' }> };

/** The way into a running session's chat: none yet, a pass to its host, or why there is none. */
export type ChatAccess =
  | { kind: 'none' }
  | { kind: 'open'; pass: string; hostUrl: string }
  | { kind: 'refused'; message: string };

/**
 * One cloud session, read while it is shown, and the way into its chat. Its session page and its
 * run's Conversation tab (an agent run's) both hold a session this way.
 *
 * It reads the session again every 2 s while it starts and every 10 s while it runs (5 s for an
 * agent run, whose report moves), and never once it has ended. It asks the cell for a pass once it
 * reads the session running; the read that finds it ended drops the pass, which unmounts the chat
 * and its connection, and nothing reconnects. A read that fails while the cell or `cloud-global`
 * is out keeps the session as it was read, saying when (`keepsShownOn`); any other refusal (gone,
 * signed out, another workspace) shows instead, and a running chat goes with its pass.
 */
export function useCloudSession(workspace: MyWorkspace, sessionId: string) {
  const [view, setView] = useState<SessionView>({ kind: 'loading' });
  const [access, setAccess] = useState<ChatAccess>({ kind: 'none' });
  // What the reads and the chat's renewal see as they start.
  const latest = useRef({ view, access });
  latest.current = { view, access };

  const readNow = usePoll(`${workspace.id} ${sessionId}`, async (current) => {
    const answer = await cloudSessionsService.loadSession(workspace, sessionId);
    if (!current()) return null;
    if (answer.kind !== 'found') {
      const previous = latest.current.view;
      if (keepsShownOn(answer) && previous.kind === 'shown') {
        // The session stays as it was read, saying when; the next read may work.
        setView({ ...previous, failedAt: previous.failedAt ?? new Date().toISOString() });
        return sessionPollIntervalMs(previous.session);
      }
      // Gone, signed out or switched: the page says so, and a running chat unmounts with its pass.
      setView({ kind: 'refused', answer });
      setAccess({ kind: 'none' });
      return null;
    }

    const { session } = answer;
    setView({ kind: 'shown', session, failedAt: null });
    if (!chatMounted(session.status)) {
      // The chat unmounts; its pass is forgotten with it.
      setAccess({ kind: 'none' });
    } else if (latest.current.access.kind !== 'open') {
      const pass = await cloudSessionsService.issuePass(workspace, sessionId);
      if (!current()) return null;
      if (pass.kind === 'issued') {
        setAccess({ kind: 'open', pass: pass.pass.pass, hostUrl: pass.pass.hostUrl });
      } else if (pass.kind !== 'not-found') {
        setAccess({ kind: 'refused', message: messageForPassAnswer(pass, workspace) });
      }
      // Not found: the host has not said its address yet, or the session just ended. The next
      // read asks again, or finds it ended.
    }
    return sessionPollIntervalMs(session);
  });

  /** The chat's `onPassExpired`: a new pass from the cell, only while the session runs. */
  const renewPass = async (): Promise<string> => {
    const shown = latest.current.view;
    if (shown.kind !== 'shown' || !shouldRenewPass(shown.session.status)) {
      throw new Error(messageForPassAnswer({ kind: 'not-found' }, workspace));
    }
    try {
      return await cloudSessionsService.renewPass(workspace, sessionId);
    } catch (error) {
      // The session has most likely ended: read it now, so the chat goes without waiting. Its
      // pass is dropped, so a session still running gets a new one from that read (or a later
      // one, at the poll's pace), never from a loop of the chat's own.
      setAccess({ kind: 'none' });
      readNow();
      throw error;
    }
  };

  /**
   * A session the page learned of itself, a stop's answer: shown at once with no chat, then read
   * again, since a read already under way may predate it and must never be shown.
   */
  const showStopped = (session: CloudSession) => {
    setView({ kind: 'shown', session, failedAt: null });
    setAccess({ kind: 'none' });
    readNow();
  };

  return { view, access, readNow, renewPass, showStopped };
}
