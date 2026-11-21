import { describe, expect, it } from 'vitest';
import { messageForSignInError } from './signInError';

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
