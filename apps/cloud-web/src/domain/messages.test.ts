import { describe, expect, it } from 'vitest';
import {
  messageForActionFailure,
  messageForSignInError,
  messageForSwitchFailure,
  messagesForCreateRefusal,
  messagesForWorkspaceProblems,
  WORKSPACES_UNAVAILABLE,
} from './messages';

const notAnswering = 'Consola Cloud’s service isn’t answering. Try again in a moment.';

describe('messageForActionFailure', () => {
  it('asks to wait after a 429', () => {
    expect(messageForActionFailure({ status: 429 })).toBe(
      'Too many sign-in attempts. Wait a minute and try again.',
    );
  });

  it('says the service is not answering for any other status', () => {
    expect(messageForActionFailure({ status: 500 })).toBe(notAnswering);
    expect(messageForActionFailure({})).toBe(notAnswering);
  });

  it('says the service is not answering for a thrown error', () => {
    expect(messageForActionFailure(new TypeError('Failed to fetch'))).toBe(notAnswering);
    expect(messageForActionFailure(undefined)).toBe(notAnswering);
  });
});

describe('messageForSignInError', () => {
  it('says nothing when there is no error', () => {
    expect(messageForSignInError(null)).toBeNull();
  });

  it('says the sign-in was cancelled', () => {
    expect(messageForSignInError('access_denied')).toBe('Google sign-in was cancelled.');
  });

  it('asks for a verified Google account', () => {
    const sentence = 'Consola Cloud needs a Google account with a verified email address.';
    expect(messageForSignInError('unable_to_create_user')).toBe(sentence);
    expect(messageForSignInError('email_not_verified')).toBe(sentence);
  });

  it('asks to try again for a stale state and for any unknown code', () => {
    const sentence = 'Google sign-in didn’t finish. Try again.';
    expect(messageForSignInError('state_mismatch')).toBe(sentence);
    expect(messageForSignInError('something_new')).toBe(sentence);
  });
});

const slugRule = 'Use lowercase letters, digits and single dashes, up to 48 characters.';

describe('messagesForWorkspaceProblems', () => {
  it('puts each problem under the field it is about', () => {
    expect(
      messagesForWorkspaceProblems(['name_missing', 'slug_invalid', 'region_unknown']),
    ).toEqual({
      name: 'Give the workspace a name.',
      slug: slugRule,
      region: 'Pick a region.',
    });
    expect(messagesForWorkspaceProblems(['name_too_long'])).toEqual({
      name: 'Keep the name to 64 characters or fewer.',
    });
  });

  it('says nothing when there is no problem', () => {
    expect(messagesForWorkspaceProblems([])).toEqual({});
  });
});

describe('messagesForCreateRefusal', () => {
  it('shows the server’s problems under their fields', () => {
    expect(messagesForCreateRefusal({ kind: 'invalid', problems: ['slug_invalid'] })).toEqual({
      slug: slugRule,
    });
  });

  it('says the request was refused when the server named no problem the page knows', () => {
    expect(messagesForCreateRefusal({ kind: 'invalid', problems: [] })).toEqual({
      form: 'Consola Cloud didn’t accept this workspace. Check the details and try again.',
    });
  });

  it('asks for another slug when the one asked for is taken', () => {
    expect(messagesForCreateRefusal({ kind: 'slug-taken' })).toEqual({
      slug: 'Another workspace already has this slug. Pick another.',
    });
  });

  it('says the service is not answering when it is unavailable', () => {
    expect(messagesForCreateRefusal({ kind: 'unavailable' })).toEqual({ form: notAnswering });
  });
});

describe('messageForSwitchFailure', () => {
  it('says the person is no longer in a workspace the server did not find', () => {
    expect(messageForSwitchFailure({ kind: 'not-found' })).toBe(
      'You’re no longer in that workspace.',
    );
  });

  it('says the service is not answering when it is unavailable', () => {
    expect(messageForSwitchFailure({ kind: 'unavailable' })).toBe(notAnswering);
  });
});

describe('WORKSPACES_UNAVAILABLE', () => {
  it('says the list could not be loaded', () => {
    expect(WORKSPACES_UNAVAILABLE).toBe('Your workspaces couldn’t be loaded.');
  });
});
