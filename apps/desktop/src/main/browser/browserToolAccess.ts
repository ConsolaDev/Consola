import { z } from 'zod';
import type { BrowserTabSnapshot } from '../../shared/browser';
import type { Session, Workspace } from '../../shared/workspace';
import type { BrowserService } from './BrowserService';
import type { HeldDialog, PageDialogs } from './PageDialogs';
import type { BrowserToolContent } from './browserToolResults';

/**
 * What every browser tool shares: who may call it, which tabs it may name,
 * and how an answer or a refusal reaches the agent. The tools that look
 * (`browserTools`) and the tools that act (`browserActTools`) both stand on it.
 */

/** Any tab id that is not the caller's, whether it exists elsewhere or not. */
export const ANOTHER_SESSION_MESSAGE = 'That tab belongs to another session.';
const GONE_MESSAGE = 'This session no longer exists.';
const READ_ONLY_MESSAGE = 'A read-only session cannot use the browser.';
const ACCESS_OFF_MESSAGE =
  "Agents may not use this workspace's browser; the person turned that off in its settings.";

/**
 * Why a session's agent may not use its workspace's browser now, or null
 * when it may. Asked once when a session's MCP server is built, to decide
 * whether it gets the tools at all, and again on every call, since access can
 * be turned off, or the session deleted or made read-only, after that.
 */
export function browserRefusal(
  workspace: Workspace | undefined,
  session: Session | undefined,
): string | null {
  if (!workspace || !session) return GONE_MESSAGE;
  if (session.toolPolicy === 'read-only') return READ_ONLY_MESSAGE;
  if (workspace.browserAgentAccess === 'off') return ACCESS_OFF_MESSAGE;
  return null;
}

/** What `CallerAccess` reads: the workspaces, and the caller's tabs. */
export interface CallerAccessDeps {
  getWorkspaces(): Workspace[];
  browser: Pick<BrowserService, 'snapshotFor'>;
}

/**
 * One session's hold on the browser, from the endpoint its call arrived on
 * (Invariant 5): never from an argument, and asked afresh on every call.
 */
export class CallerAccess {
  constructor(
    private readonly deps: CallerAccessDeps,
    public readonly sessionId: string,
  ) {}

  /** The caller's workspace and session, or throws why it may not use the browser now. */
  public check(): { workspace: Workspace; session: Session } {
    const workspace = this.deps
      .getWorkspaces()
      .find((candidate) => candidate.sessions.some((session) => session.id === this.sessionId));
    const session = workspace?.sessions.find((candidate) => candidate.id === this.sessionId);
    const refusal = browserRefusal(workspace, session);
    if (refusal || !workspace || !session) throw new Error(refusal ?? GONE_MESSAGE);
    return { workspace, session };
  }

  /**
   * One of the caller's own tabs, live state included. Any other id is
   * refused in the same words, so an agent cannot learn what another session
   * holds.
   */
  public tab(tabId: string): BrowserTabSnapshot {
    this.check();
    const tab = this.deps.browser
      .snapshotFor(this.sessionId)
      .tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(ANOTHER_SESSION_MESSAGE);
    return tab;
  }
}

/** What the tools need of the dialogs main holds for the agent. */
export type ToolDialogs = Pick<PageDialogs, 'pendingFor' | 'opened' | 'answer'>;

/** "an alert dialog", "a confirm dialog", "a prompt dialog". */
export function aDialog(dialog: HeldDialog): string {
  return `${dialog.type === 'alert' ? 'an' : 'a'} ${dialog.type} dialog`;
}

/**
 * Refuses a call on a page that is waiting on an answer to a dialog: until
 * it has one, the page answers nothing else, so the call would only wait.
 */
export function refuseWhileDialog(dialogs: ToolDialogs, tabId: string): void {
  const pending = dialogs.pendingFor(tabId);
  if (pending) {
    throw new Error(
      `The page is showing ${aDialog(pending)} and waits for an answer; answer it with consola_browser_dialog first.`,
    );
  }
}

export type ToolAnswer = { content: BrowserToolContent[]; isError?: boolean };

/**
 * A failure that carries page text (an exception the page threw), answered
 * as an error whose content still opens with the untrusted note.
 */
export class PageTextError extends Error {
  constructor(public readonly content: BrowserToolContent[]) {
    super(content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));
  }
}

/** Runs a call; a refusal or failure is a tool error carrying only its message. */
export async function answer(
  work: () => BrowserToolContent[] | Promise<BrowserToolContent[]>,
): Promise<ToolAnswer> {
  try {
    return { content: await work() };
  } catch (error) {
    if (error instanceof PageTextError) return { isError: true, content: error.content };
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/** An answer with no page text in it, so no untrusted note. */
export function plain(value: Record<string, unknown>): BrowserToolContent[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export const tabIdInput = z
  .string()
  .min(1)
  .describe('A tabId from consola_browser_status or _open.');
