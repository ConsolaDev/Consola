import { describe, expect, it } from 'vitest';
import { SLACK_APP_STATES, SLACK_RESULTS, SLACK_STEPS } from './slack';
import type { SlackLinkRequest } from './slack';
import {
  installedWhere,
  isSlackSuccess,
  linkGoneWords,
  linkQuestion,
  messageForConfirmFailure,
  messageForInstallFailure,
  messageForSlackResult,
  messagesForCredentialsAnswer,
  messagesForCredentialsProblems,
  otherWorkspaceWords,
  SLACK_STATE_WORDS,
  createStepHint,
  SLACK_STEP_TITLES,
} from './slackMessages';

describe('the setup’s words', () => {
  it('names every state and every step', () => {
    for (const state of SLACK_APP_STATES) expect(SLACK_STATE_WORDS[state]).toBeTruthy();
    for (const step of SLACK_STEPS) expect(SLACK_STEP_TITLES[step]).toBeTruthy();
  });

  it('names the bot when creating the app, and says an admin may be needed', () => {
    const hint = createStepHint('code-review');
    expect(hint).toContain('@code-review');
    expect(hint).toContain('admin');
  });

  it('says where an installed app is', () => {
    expect(
      installedWhere({ handle: 'code-review', team: { id: 'T024BE7LD', name: 'Sprocket' } }),
    ).toBe('@code-review in Sprocket');
    expect(installedWhere({ handle: 'code-review', team: null })).toBe('@code-review');
  });
});

describe('the credentials’ words', () => {
  it('says each problem under its own field, the first only', () => {
    expect(messagesForCredentialsProblems(['client_id_invalid', 'signing_secret_missing'])).toEqual(
      {
        clientId:
          'A Client ID is two numbers joined by a dot, like 1234567890.1234567890. The App ID is another value.',
        signingSecret: 'Paste the Signing Secret.',
      },
    );
  });

  it('says a refusal with no problem named for the whole form', () => {
    expect(messagesForCredentialsAnswer({ kind: 'invalid', problems: [] })).toEqual({
      form: 'Slack’s credentials didn’t look right. Copy them again from App Credentials.',
    });
    expect(messagesForCredentialsAnswer({ kind: 'not-allowed' }).form).toContain('owners');
  });

  it('says why Add to Slack did not start', () => {
    expect(messageForInstallFailure({ kind: 'no-credentials' })).toContain('Paste them first');
    expect(messageForInstallFailure({ kind: 'unavailable' })).toContain('isn’t answering');
  });
});

describe('how Add to Slack ended', () => {
  it('has a sentence for every result, and only installed is good news', () => {
    for (const result of SLACK_RESULTS) {
      expect(messageForSlackResult(result)).toBeTruthy();
      expect(isSlackSuccess(result)).toBe(result === 'installed');
    }
    expect(messageForSlackResult('wrong_app')).toContain('different app');
    expect(messageForSlackResult('unknown')).toBe(
      'Slack didn’t finish adding the app. Try Add to Slack again.',
    );
  });
});

describe('the link page’s words', () => {
  const request: SlackLinkRequest = {
    state: 'open',
    workspaceId: 'ws-sprocket',
    inActiveWorkspace: true,
    slackTeamId: 'T024BE7LD',
    slackUserId: 'U012AB3CD',
    slackTeamName: 'Sprocket Slack',
    factory: { id: 'f-1', name: 'Code review' },
    expiresAt: '2026-11-27T10:15:00.000Z',
  };

  it('asks to link the Slack account in its workspace to the person in theirs', () => {
    expect(linkQuestion(request, 'Sprocket')).toBe(
      'Link Slack account U012AB3CD in Sprocket Slack to you in Sprocket?',
    );
    expect(linkQuestion({ ...request, slackTeamName: null }, 'Sprocket')).toBe(
      'Link Slack account U012AB3CD in T024BE7LD to you in Sprocket?',
    );
  });

  it('says why a link no longer works, and to mention the bot again for a new one', () => {
    expect(linkGoneWords('expired', 'Code review')).toBe(
      'This link has expired. Mention Code review’s bot in Slack again for a new one.',
    );
    expect(linkGoneWords('used', null)).toBe(
      'This link was already used. Mention the factory’s bot in Slack again for a new one.',
    );
    expect(messageForConfirmFailure({ kind: 'gone', why: 'used' }, 'Code review')).toBe(
      linkGoneWords('used', 'Code review'),
    );
  });

  it('says which workspace the link is for, and which is open', () => {
    expect(otherWorkspaceWords('Sprocket', 'Sprocket Labs')).toBe(
      'This link is for Sprocket, and you have Sprocket Labs open. Switch to link your account there.',
    );
    expect(otherWorkspaceWords(null, 'Sprocket Labs')).toContain('another of your workspaces');
  });
});
