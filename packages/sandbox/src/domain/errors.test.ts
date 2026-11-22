import { describe, expect, it } from 'vitest';
import { asSandboxError, isSandboxError, SandboxError } from './errors';

describe('SandboxError', () => {
  it('carries its code, and is told apart by it', () => {
    const error = new SandboxError('not-found', 'There is no file at /tmp/a.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SandboxError');
    expect(isSandboxError(error)).toBe(true);
    expect(isSandboxError(error, 'not-found')).toBe(true);
    expect(isSandboxError(error, 'invalid')).toBe(false);
    expect(isSandboxError(new Error('x'))).toBe(false);
  });

  it('keeps a SandboxError as it is', () => {
    const error = new SandboxError('not-running', 'Stopped.');
    expect(asSandboxError(error)).toBe(error);
  });

  it("wraps anything else as a provider error with the provider's message, and the original as cause", () => {
    const original = new Error('Template consola-session not found');
    const wrapped = asSandboxError(original);
    expect(wrapped.code).toBe('provider');
    expect(wrapped.message).toBe('Template consola-session not found');
    expect(wrapped.cause).toBe(original);
    expect(asSandboxError('quota exceeded').message).toBe('quota exceeded');
  });

  it('says so when the provider gave no message', () => {
    expect(asSandboxError(new Error('')).message).toMatch(/without saying why/);
    expect(asSandboxError(undefined).message).toBe('undefined');
  });
});
