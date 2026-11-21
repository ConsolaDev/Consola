import type { AutomationNotice } from '@consola/automation-engine';

/** Where a click on an automation's notification lands. */
export type NoticeTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'automation'; name: string }
  | { kind: 'automations'; runId?: string };

/**
 * The session a run started, first; else the automation's page, for a notice
 * about an automation and not a run (one that needs Allow, or can't check);
 * else the workspace's Automations, on the run when there is one.
 */
export function noticeTarget(
  notice: Pick<AutomationNotice, 'sessionId' | 'automation' | 'runId'>,
): NoticeTarget {
  if (notice.sessionId) return { kind: 'session', sessionId: notice.sessionId };
  if (notice.automation) return { kind: 'automation', name: notice.automation };
  return notice.runId ? { kind: 'automations', runId: notice.runId } : { kind: 'automations' };
}
