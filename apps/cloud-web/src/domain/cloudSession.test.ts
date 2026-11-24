import { describe, expect, it } from 'vitest';
import type { paths } from './cellApiContract';
import {
  type CellFailureCode,
  type CloudSession,
  type CloudSessionStatus,
  chatMounted,
  keepsShownOn,
  type Harness,
  listPollIntervalMs,
  pollIntervalMs,
  type StartRefusalCode,
  sessionLabel,
  sessionScreen,
  shouldRenewPass,
  startedAt,
} from './cloudSession';
import {
  HARNESS_NAMES,
  messageForPassAnswer,
  messageForSessionAnswer,
  messageForStartAnswer,
  messageForStopAnswer,
  NO_RUNNER_WORDS,
  SESSION_STATUS_WORDS,
  START_NOTE,
} from './cloudSessionMessages';

const session: CloudSession = {
  id: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  workspaceId: 'ws-acme',
  personId: 'p-ada',
  repository: 'sprocket/catalog-portal',
  harness: 'claude',
  status: 'running',
  title: 'Fix the flaky login test',
  hostUrl: 'https://7420-sandbox.e2b.test',
  error: null,
  errorCode: null,
  runnerId: 'runner-1',
  createdAt: 1_795_000_000,
  endedAt: null,
};

const ACME = { name: 'Acme', region: 'eu' };

describe('the contract', () => {
  it('names every harness, failure code and status the cell has', () => {
    // A harness, a code or a status the cell gains fails the typecheck until the page words it.
    const harnesses: Record<Harness, string> = HARNESS_NAMES;
    const statuses: Record<CloudSessionStatus, string> = SESSION_STATUS_WORDS;
    expect(Object.keys(harnesses).sort()).toEqual(['claude', 'codex']);
    expect(Object.keys(statuses).sort()).toEqual(['failed', 'running', 'starting', 'stopped']);
  });

  it('refuses a start only with the codes the cell answers', () => {
    type Refused =
      | paths['/api/cloud-sessions']['post']['responses'][400]['content']['application/json']['error']
      | paths['/api/cloud-sessions']['post']['responses'][503]['content']['application/json']['error'];
    const exact: Exclude<Refused, 'token_check_unavailable'> extends StartRefusalCode
      ? StartRefusalCode extends Exclude<Refused, 'token_check_unavailable'>
        ? true
        : false
      : false = true;
    expect(exact).toBe(true);
  });
});

describe('sessionLabel', () => {
  it('is the session’s title', () => {
    expect(sessionLabel(session)).toBe('Fix the flaky login test');
  });

  it('is “Session” and the id’s first eight characters while it has no title', () => {
    expect(sessionLabel({ ...session, title: null })).toBe('Session 1a2b3c4d');
    expect(sessionLabel({ ...session, title: '   ' })).toBe('Session 1a2b3c4d');
  });
});

describe('pollIntervalMs', () => {
  it('reads a starting session every 2 s, a running one every 10 s, and an ended one never', () => {
    expect(pollIntervalMs('starting')).toBe(2000);
    expect(pollIntervalMs('running')).toBe(10000);
    expect(pollIntervalMs('stopped')).toBeNull();
    expect(pollIntervalMs('failed')).toBeNull();
  });
});

describe('listPollIntervalMs', () => {
  it('reads the list as often as its liveliest session asks', () => {
    expect(
      listPollIntervalMs([{ status: 'running' }, { status: 'starting' }, { status: 'stopped' }]),
    ).toBe(2000);
    expect(listPollIntervalMs([{ status: 'running' }, { status: 'failed' }])).toBe(10000);
  });

  it('reads it now and then once no session shown can change, for one started elsewhere', () => {
    expect(listPollIntervalMs([{ status: 'stopped' }, { status: 'failed' }])).toBe(30000);
    expect(listPollIntervalMs([])).toBe(30000);
  });
});

describe('keepsShownOn', () => {
  it('keeps what was shown through a read that failed for a while: the next may work', () => {
    expect(keepsShownOn({ kind: 'unavailable' })).toBe(true);
    expect(keepsShownOn({ kind: 'pending' })).toBe(true);
  });

  it('ends what was shown, a running chat included, once signed out or switched', () => {
    expect(keepsShownOn({ kind: 'signed-out' })).toBe(false);
    expect(keepsShownOn({ kind: 'switched' })).toBe(false);
  });

  it('ends a session the cell no longer has', () => {
    expect(keepsShownOn({ kind: 'not-found' })).toBe(false);
  });
});

describe('the chat and its pass', () => {
  it('mounts the chat and renews its pass only while the session runs', () => {
    expect(chatMounted('running')).toBe(true);
    expect(shouldRenewPass('running')).toBe(true);
    for (const status of ['starting', 'stopped', 'failed'] as const) {
      expect(chatMounted(status)).toBe(false);
      expect(shouldRenewPass(status)).toBe(false);
    }
  });

  it('unmounts the chat and asks no new pass once a running session stops', () => {
    const seen = (['running', 'stopped'] as const).map((status) => ({
      mounted: chatMounted(status),
      renew: shouldRenewPass(status),
      poll: pollIntervalMs(status),
    }));
    expect(seen).toEqual([
      { mounted: true, renew: true, poll: 10000 },
      { mounted: false, renew: false, poll: null },
    ]);
  });
});

describe('sessionScreen', () => {
  it('says the sandbox is starting', () => {
    expect(sessionScreen({ ...session, status: 'starting' })).toEqual({
      kind: 'starting',
      words: 'Starting the sandbox…',
    });
  });

  it('shows the chat with the warning above it, and Stop, while running', () => {
    expect(sessionScreen(session)).toEqual({
      kind: 'running',
      warning: 'Changes not pushed to a branch are lost when this session stops.',
    });
  });

  it('says the session stopped, with no composer', () => {
    expect(sessionScreen({ ...session, status: 'stopped' })).toEqual({
      kind: 'stopped',
      words: 'This session has stopped.',
    });
  });

  it('says a failure with the runner’s message as it came', () => {
    expect(
      sessionScreen({
        ...session,
        status: 'failed',
        error: 'clone-failed: repository not found',
      }),
    ).toEqual({
      kind: 'failed',
      words: 'This session failed: clone-failed: repository not found',
    });
  });

  it.each([
    ['runner_restarted', 'The runner restarted.'],
    ['runner_unreachable', 'The runner couldn’t be reached to start this session.'],
    ['runner_failed', 'The runner stopped this session without saying why.'],
  ] satisfies [CellFailureCode, string][])(
    'words the cell’s code %s, never the code itself',
    (errorCode, words) => {
      expect(sessionScreen({ ...session, status: 'failed', errorCode })).toEqual({
        kind: 'failed',
        words,
      });
    },
  );

  it('says the session failed when the cell gave neither a message nor a code it knows', () => {
    expect(sessionScreen({ ...session, status: 'failed' })).toEqual({
      kind: 'failed',
      words: 'This session failed.',
    });
    expect(
      sessionScreen({
        ...session,
        status: 'failed',
        errorCode: 'runner_exploded' as CellFailureCode,
      }),
    ).toEqual({ kind: 'failed', words: 'This session failed.' });
  });
});

describe('startedAt', () => {
  it('is the session’s start, from the cell’s epoch seconds', () => {
    expect(startedAt(session)).toBe('2026-11-18T11:06:40.000Z');
  });
});

describe('the sentences', () => {
  it('says no runner is connected', () => {
    expect(NO_RUNNER_WORDS).toBe('No runner is connected for this workspace.');
    expect(messageForStartAnswer({ kind: 'refused', code: 'no_runner' }, session, ACME)).toBe(
      'No runner is connected for this workspace.',
    );
    expect(messageForPassAnswer({ kind: 'no-runner' }, ACME)).toBe(
      'No runner is connected for this workspace.',
    );
  });

  it('names the repository or the harness the runner does not offer', () => {
    expect(
      messageForStartAnswer({ kind: 'refused', code: 'repository_not_offered' }, session, ACME),
    ).toBe('This runner does not offer sprocket/catalog-portal.');
    expect(
      messageForStartAnswer(
        { kind: 'refused', code: 'harness_not_offered' },
        { ...session, harness: 'codex' },
        ACME,
      ),
    ).toBe('This runner has no API key for Codex.');
    expect(
      messageForStartAnswer({ kind: 'refused', code: 'harness_not_offered' }, session, ACME),
    ).toBe('This runner has no API key for Claude Code.');
  });

  it('says a start the cell could not read', () => {
    expect(messageForStartAnswer({ kind: 'refused', code: 'invalid_request' }, session, ACME)).toBe(
      'The region couldn’t read this repository or harness. Pick them again.',
    );
  });

  it('says a refusal of the cell’s the way every page of the cell does', () => {
    expect(messageForStartAnswer({ kind: 'unavailable' }, session, ACME)).toBe(
      'The EU region isn’t answering. Start it with pnpm dev:cloud-region and try again.',
    );
    expect(messageForSessionAnswer({ kind: 'signed-out' }, ACME)).toBe(
      'You’ve been signed out. Reload to sign in again.',
    );
  });

  it('says a session that is not the person’s, or not there', () => {
    const gone = 'This session isn’t here. It may be someone else’s, or the link may be wrong.';
    expect(messageForSessionAnswer({ kind: 'not-found' }, ACME)).toBe(gone);
    expect(messageForStopAnswer({ kind: 'not-found' }, ACME)).toBe(gone);
  });

  it('says what starting a session trusts', () => {
    expect(START_NOTE).toBe(
      'Starting a session runs this repository’s own settings and hooks inside a sandbox for this session.',
    );
  });
});
