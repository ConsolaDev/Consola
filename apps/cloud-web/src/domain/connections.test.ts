import { describe, expect, expectTypeOf, it } from 'vitest';
import type { components } from './apiContract';
import {
  accountCount,
  connectAccountLabel,
  connectedAtLong,
  connectedSentence,
  messageForChoiceFailure,
  messageForGitHubResult,
  repositoryCount,
} from './connectionMessages';
import {
  accountKind,
  avatarUrl,
  DAYS_AGO_SHOWN,
  GITHUB_RESULTS,
  isSuccess,
  JUST_CONNECTED_MS,
  justConnectedId,
  MAX_CHOICE_LENGTH,
  readGitHubResult,
  readGitHubReturn,
  resultOfChoice,
  whenConnected,
} from './connections';
import type {
  ChoiceState,
  ChooseAnswer,
  GitHubCandidate,
  GitHubConnection,
  GitHubResult,
} from './connections';

describe("a Connect's result", () => {
  it('is read when the page knows it', () => {
    expect(readGitHubResult('connected')).toBe('connected');
    expect(readGitHubResult('not_account_admin')).toBe('not_account_admin');
  });

  it('is unknown for one the page does not know, and null for none', () => {
    expect(readGitHubResult('something_new')).toBe('unknown');
    expect(readGitHubResult('')).toBe('unknown');
    expect(readGitHubResult(null)).toBeNull();
  });

  it('is good news only when GitHub is connected', () => {
    expect(isSuccess('connected')).toBe(true);
    expect(isSuccess('already_connected')).toBe(true);
    for (const result of GITHUB_RESULTS.filter((each) => !each.includes('connected'))) {
      expect(isSuccess(result)).toBe(false);
    }
    expect(isSuccess('unknown')).toBe(false);
  });

  it('has a sentence for every result, the unknown one included', () => {
    for (const result of [...GITHUB_RESULTS, 'unknown' as const]) {
      expect(messageForGitHubResult(result)).toMatch(/\.$/);
    }
  });

  it("names every result the API's callback can send, as its contract lists them", () => {
    // A result the API gains fails the typecheck here until the page names it.
    expectTypeOf<GitHubResult>().toEqualTypeOf<components['schemas']['GitHubCallbackResult']>();
    expect(new Set(GITHUB_RESULTS).size).toBe(GITHUB_RESULTS.length);
  });
});

describe('what the callback sent the page back with', () => {
  it('is a Connect that ended, as `?github=` names it', () => {
    expect(readGitHubReturn('connected', null)).toEqual({ kind: 'ended', result: 'connected' });
    expect(readGitHubReturn('taken', 'ignored')).toEqual({ kind: 'ended', result: 'taken' });
    expect(readGitHubReturn('something_new', null)).toEqual({ kind: 'ended', result: 'unknown' });
  });

  it('is a choice to make, with the choice the API signed', () => {
    expect(readGitHubReturn('choose', 'eyJ3.c2ln')).toEqual({
      kind: 'choose',
      choice: 'eyJ3.c2ln',
    });
  });

  it('is a Connect that did not finish for a choose with no choice, or one too long', () => {
    for (const choice of [null, '', 'x'.repeat(MAX_CHOICE_LENGTH + 1)]) {
      expect(readGitHubReturn('choose', choice)).toEqual({ kind: 'ended', result: 'unknown' });
    }
    expect(readGitHubReturn('choose', 'x'.repeat(MAX_CHOICE_LENGTH))).toMatchObject({
      kind: 'choose',
    });
  });

  it('is nothing without a result', () => {
    expect(readGitHubReturn(null, null)).toBeNull();
    expect(readGitHubReturn(null, 'eyJ3.c2ln')).toBeNull();
  });
});

describe('a choice of account', () => {
  const sprocket: GitHubCandidate = {
    id: 41,
    account: { id: 9001, login: 'sprocket', type: 'Organization' },
  };

  it('names each account on its button', () => {
    expect(connectAccountLabel(sprocket.account.login)).toBe('Connect sprocket');
  });

  it('ends as the Connect results the page already says', () => {
    expect(resultOfChoice({ kind: 'connected' })).toBe('connected');
    expect(resultOfChoice({ kind: 'already-connected' })).toBe('already_connected');
    expect(isSuccess(resultOfChoice({ kind: 'connected' }))).toBe(true);
  });

  it('has a sentence for every way it cannot be shown', () => {
    const states: Array<Exclude<ChoiceState, { kind: 'loaded' }>> = [
      { kind: 'refused', reason: 'bad-choice' },
      { kind: 'refused', reason: 'expired' },
      { kind: 'refused', reason: 'other-workspace' },
      { kind: 'refused', reason: 'not-allowed' },
      { kind: 'signed-out' },
      { kind: 'switched' },
      { kind: 'unavailable' },
    ];
    const sentences = states.map(messageForChoiceFailure);
    for (const sentence of sentences) expect(sentence).toMatch(/\.$/);
    // Each refusal says its own reason.
    expect(new Set(sentences.slice(0, 4)).size).toBe(4);
    expect(messageForChoiceFailure({ kind: 'refused', reason: 'expired' })).toMatch(/too long/);
    expect(messageForChoiceFailure({ kind: 'refused', reason: 'bad-choice' })).toMatch(
      /another session/,
    );
  });

  it('has a sentence for every way choosing can fail', () => {
    const answers: Array<Exclude<ChooseAnswer, { kind: 'connected' | 'already-connected' }>> = [
      { kind: 'refused', reason: 'not-a-candidate' },
      { kind: 'refused', reason: 'taken' },
      { kind: 'refused', reason: 'expired' },
      { kind: 'signed-out' },
      { kind: 'unavailable' },
    ];
    for (const answer of answers) expect(messageForChoiceFailure(answer)).toMatch(/\.$/);
    expect(messageForChoiceFailure({ kind: 'refused', reason: 'taken' })).toMatch(
      /Another Consola workspace/,
    );
  });

  it('says a choose that carried no choice as a Connect that did not finish', () => {
    expect(messageForGitHubResult('choose')).toBe(messageForGitHubResult('unknown'));
    expect(isSuccess('choose')).toBe(false);
  });
});

describe("an account's picture", () => {
  it("is GitHub's avatar for the account's id, at the size asked", () => {
    expect(avatarUrl({ id: 9002, login: 'sprocket', type: 'Organization' }, 64)).toBe(
      'https://avatars.githubusercontent.com/u/9002?s=64&v=4',
    );
  });
});

describe('the installation a Connect just added', () => {
  const now = Date.parse('2026-11-22T21:00:00Z');
  const installation = (id: number, connectedAt: string): GitHubConnection => ({
    id,
    account: { id, login: `account-${id}`, type: 'Organization' },
    connectedAt,
    settingsUrl: `https://github.com/settings/installations/${id}`,
    repositories: { kind: 'listed', repositories: [] },
  });

  it('is the newest one, when it is recent', () => {
    const installations = [
      installation(1, '2026-11-01T10:00:00Z'),
      installation(2, '2026-11-22T20:58:00Z'),
      installation(3, '2026-11-20T10:00:00Z'),
    ];
    expect(justConnectedId(installations, now)).toBe(2);
  });

  it('is none when even the newest is older than a few minutes', () => {
    const installations = [installation(1, '2026-11-22T20:00:00Z')];
    expect(justConnectedId(installations, now)).toBeNull();
    expect(
      justConnectedId(installations, Date.parse('2026-11-22T20:00:00Z') + JUST_CONNECTED_MS),
    ).toBe(1);
  });

  it('skips a time it cannot read, and is none for no installations', () => {
    expect(justConnectedId([installation(1, 'not a time')], now)).toBeNull();
    expect(justConnectedId([], now)).toBeNull();
  });
});

describe('when an installation was connected', () => {
  const now = new Date(2026, 10, 22, 21, 0);

  it('is today for any time earlier the same day, or later than now', () => {
    expect(whenConnected(new Date(2026, 10, 22, 0, 5).toISOString(), now)).toEqual({
      kind: 'today',
    });
    expect(whenConnected(new Date(2026, 10, 22, 23, 0).toISOString(), now)).toEqual({
      kind: 'today',
    });
  });

  it('counts calendar days, not hours, for the last few days', () => {
    expect(whenConnected(new Date(2026, 10, 21, 23, 59).toISOString(), now)).toEqual({
      kind: 'days-ago',
      days: 1,
    });
    expect(whenConnected(new Date(2026, 10, 22 - DAYS_AGO_SHOWN, 9).toISOString(), now)).toEqual({
      kind: 'days-ago',
      days: DAYS_AGO_SHOWN,
    });
  });

  it('is a date once it is longer ago, and null for a time it cannot read', () => {
    const long = new Date(2026, 10, 22 - DAYS_AGO_SHOWN - 1, 9);
    expect(whenConnected(long.toISOString(), now)).toEqual({ kind: 'on', date: long });
    expect(whenConnected('not a time', now)).toBeNull();
  });
});

describe("an installation's card says when it was connected", () => {
  const now = new Date(2026, 10, 22, 21, 0);

  it('in words for the last few days', () => {
    expect(connectedSentence(new Date(2026, 10, 22, 9).toISOString(), now)).toBe('connected today');
    expect(connectedSentence(new Date(2026, 10, 21, 9).toISOString(), now)).toBe(
      'connected yesterday',
    );
    expect(connectedSentence(new Date(2026, 10, 19, 9).toISOString(), now)).toBe(
      'connected 3 days ago',
    );
  });

  it('as a date after that, and not at all for a time it cannot read', () => {
    expect(connectedSentence(new Date(2026, 7, 24, 9).toISOString(), now)).toMatch(
      /^connected .*2026/,
    );
    expect(connectedSentence('not a time', now)).toBeNull();
    expect(connectedAtLong('not a time')).toBeNull();
    expect(connectedAtLong(new Date(2026, 7, 24, 9).toISOString())).toMatch(/^Connected .*2026/);
  });
});

describe('the counts a card shows', () => {
  it('say one in the singular and any other number in the plural', () => {
    expect(accountCount(1)).toBe('1 account');
    expect(accountCount(3)).toBe('3 accounts');
    expect(repositoryCount(1)).toBe('1 repository');
    expect(repositoryCount(0)).toBe('0 repositories');
  });
});

describe("an installation's account", () => {
  it('is an organization or a personal account', () => {
    expect(accountKind({ id: 1, login: 'sprocket', type: 'Organization' })).toBe('Organization');
    expect(accountKind({ id: 2, login: 'dana', type: 'User' })).toBe('Personal account');
  });
});
