import { describe, expect, it } from 'vitest';
import { automationsTickMs, openInApplicationsDir } from './test-mode';

describe('openInApplicationsDir', () => {
  it('is the folder an end-to-end test gives, as an absolute path, in a test run', () => {
    expect(openInApplicationsDir('/tmp/consola-e2e/Applications', true)).toBe(
      '/tmp/consola-e2e/Applications',
    );
  });

  it('is undefined for anything else', () => {
    expect(openInApplicationsDir(undefined, true)).toBeUndefined();
    expect(openInApplicationsDir('', true)).toBeUndefined();
    expect(openInApplicationsDir('Applications', true)).toBeUndefined();
  });

  it('is never read outside a test run', () => {
    expect(openInApplicationsDir('/tmp/consola-e2e/Applications', false)).toBeUndefined();
  });
});

describe('automationsTickMs', () => {
  it('takes a whole number of at least 500 ms, in a test run', () => {
    expect(automationsTickMs('2000', true)).toBe(2000);
    expect(automationsTickMs('500', true)).toBe(500);
  });

  it('is the engine’s own tick (undefined) for anything else', () => {
    expect(automationsTickMs(undefined, true)).toBeUndefined();
    expect(automationsTickMs('', true)).toBeUndefined();
    expect(automationsTickMs('499', true)).toBeUndefined();
    expect(automationsTickMs('2s', true)).toBeUndefined();
    expect(automationsTickMs('1.5', true)).toBeUndefined();
    expect(automationsTickMs('-2000', true)).toBeUndefined();
  });

  it('is never read outside a test run', () => {
    expect(automationsTickMs('2000', false)).toBeUndefined();
  });
});
