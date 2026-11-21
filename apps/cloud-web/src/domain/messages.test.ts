import { describe, expect, it } from 'vitest';
import { messageForActionFailure, messageForSignInError } from './messages';

describe('messageForActionFailure', () => {
  const notAnswering = 'Consola Cloud’s service isn’t answering. Try again in a moment.';

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
