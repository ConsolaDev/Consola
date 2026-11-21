import type { AutomationNotice } from '@consola/automation-engine';
import { describe, expect, it } from 'vitest';
import { noticeTarget } from './noticeTarget';

const notice: AutomationNotice = {
  title: 't',
  body: 'b',
  workspaceId: 'ws-1',
  needsApproval: false,
};

describe('noticeTarget', () => {
  it('opens the session a run started, first', () => {
    expect(
      noticeTarget({ ...notice, sessionId: 's-1', runId: 'run-1', automation: 'checker' }),
    ).toEqual({ kind: 'session', sessionId: 's-1' });
  });

  it('opens the automation a notice names, when no session is', () => {
    expect(noticeTarget({ ...notice, automation: 'checker' })).toEqual({
      kind: 'automation',
      name: 'checker',
    });
  });

  it('opens Automations on the run, else Automations alone', () => {
    expect(noticeTarget({ ...notice, runId: 'run-1' })).toEqual({
      kind: 'automations',
      runId: 'run-1',
    });
    expect(noticeTarget(notice)).toEqual({ kind: 'automations' });
  });
});
