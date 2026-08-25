import { describe, expect, it } from 'vitest';
import { PROVIDER_META, isGitProviderId, type GitProviderId } from './providers';

describe('isGitProviderId', () => {
  it('accepts every registered provider id', () => {
    for (const id of Object.keys(PROVIDER_META)) {
      expect(isGitProviderId(id)).toBe(true);
    }
  });

  it('rejects unknown ids, non-strings and Object.prototype names', () => {
    expect(isGitProviderId('gitlab')).toBe(false);
    expect(isGitProviderId(42)).toBe(false);
    expect(isGitProviderId(undefined)).toBe(false);
    // `'toString' in PROVIDER_META` is true. An IPC payload naming a
    // prototype member must not pass as a provider.
    expect(isGitProviderId('toString')).toBe(false);
  });
});

describe('PROVIDER_META', () => {
  it('keys every entry by its own id', () => {
    for (const [key, meta] of Object.entries(PROVIDER_META)) {
      expect(meta.id).toBe(key as GitProviderId);
    }
  });

  it('describes GitHub through its gh CLI', () => {
    expect(PROVIDER_META.github.displayName).toBe('GitHub');
    expect(PROVIDER_META.github.cliName).toBe('gh');
    expect(PROVIDER_META.github.loginHint).toBe('gh auth login');
    expect(PROVIDER_META.github.installHint).toBe('brew install gh (or see cli.github.com)');
  });

  it('seeds every header template with the item number and a read command for its own CLI', () => {
    for (const meta of Object.values(PROVIDER_META)) {
      for (const template of Object.values(meta.seedHeaderTemplate)) {
        expect(template).toContain('{{number}}');
        expect(template).toContain(`\`${meta.cliName} `);
      }
    }
  });
});
