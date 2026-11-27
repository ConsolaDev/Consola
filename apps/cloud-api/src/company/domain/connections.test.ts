import { describe, expect, it } from 'vitest';
import {
  checkInstaller,
  checkInstallState,
  INSTALL_STATE_LIFETIME_SECONDS,
  installationSettingsUrl,
  mayManageConnections,
  newInstallState,
  readGitHubId,
} from './connections.js';
import type { GitHubInstallation } from './connections.js';

describe('a GitHub id in an address', () => {
  it('is digits with no leading zero, as a safe integer', () => {
    expect(readGitHubId('41')).toBe(41);
    expect(readGitHubId('9007199254740991')).toBe(9_007_199_254_740_991);
  });

  it('is null for anything else', () => {
    for (const value of [
      undefined,
      '',
      '0',
      '041',
      '4.1',
      '-41',
      '4e1',
      ' 41',
      '9007199254740993',
    ]) {
      expect(readGitHubId(value)).toBeNull();
    }
  });
});

describe("an installation's settings on GitHub", () => {
  it("are under the organisation's settings for an organisation", () => {
    expect(
      installationSettingsUrl({
        id: 41,
        account: { id: 1, login: 'sprocket', type: 'Organization' },
      }),
    ).toBe('https://github.com/organizations/sprocket/settings/installations/41');
  });

  it("are under the person's own settings for a person", () => {
    expect(
      installationSettingsUrl({ id: 42, account: { id: 2, login: 'dana', type: 'User' } }),
    ).toBe('https://github.com/settings/installations/42');
  });
});

describe('who may connect an installation', () => {
  const org: GitHubInstallation = {
    id: 41,
    account: { id: 9001, login: 'sprocket', type: 'Organization' },
    repositorySelection: 'selected',
  };
  const own: GitHubInstallation = {
    id: 42,
    account: { id: 7, login: 'dana', type: 'User' },
    repositorySelection: 'all',
  };

  it("an organisation's owner may connect its installation", () => {
    expect(
      checkInstaller({ installation: org, gitHubUserId: 7, organizationRole: 'admin' }),
    ).toEqual({ ok: true, installation: org });
  });

  it('a member of the organisation, or someone outside it, may not, though GitHub lists it', () => {
    for (const organizationRole of ['member', null] as const) {
      expect(checkInstaller({ installation: org, gitHubUserId: 7, organizationRole })).toEqual({
        ok: false,
        reason: 'not-account-admin',
      });
    }
  });

  it("a person may connect their own installation, and no one else's", () => {
    expect(checkInstaller({ installation: own, gitHubUserId: 7, organizationRole: null })).toEqual({
      ok: true,
      installation: own,
    });
    // Owning some organisation says nothing about another person's account.
    expect(
      checkInstaller({ installation: own, gitHubUserId: 8, organizationRole: 'admin' }),
    ).toEqual({ ok: false, reason: 'not-account-admin' });
  });

  it('no one may connect an installation GitHub does not list for them', () => {
    expect(
      checkInstaller({ installation: null, gitHubUserId: 7, organizationRole: 'admin' }),
    ).toEqual({ ok: false, reason: 'not-installer' });
  });
});

describe('who manages connections', () => {
  it('owners and admins do, members do not', () => {
    expect(mayManageConnections('owner')).toBe(true);
    expect(mayManageConnections('admin')).toBe(true);
    expect(mayManageConnections('member')).toBe(false);
  });
});

describe("a Connect's state", () => {
  const now = 1_800_000_000;
  const dana = { personId: 'dana', sessionId: 'session-1' };
  const state = newInstallState(dana, 'sprocket', now);

  it('names the workspace, the person and the session, for ten minutes', () => {
    expect(state).toEqual({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-1',
      expiresAt: now + INSTALL_STATE_LIFETIME_SECONDS,
    });
    expect(INSTALL_STATE_LIFETIME_SECONDS).toBe(600);
  });

  it('finishes a Connect only in the session that started it, in time', () => {
    expect(checkInstallState(state, dana, now + 1)).toBe('ok');
    expect(checkInstallState(state, dana, state.expiresAt - 1)).toBe('ok');
  });

  it('is expired from the second it ends', () => {
    expect(checkInstallState(state, dana, state.expiresAt)).toBe('expired');
  });

  it("is refused in another session, the person's own included, even in time", () => {
    expect(checkInstallState(state, { ...dana, sessionId: 'session-2' }, now)).toBe(
      'not-this-session',
    );
    expect(checkInstallState(state, { ...dana, personId: 'eli' }, now)).toBe('not-this-session');
  });

  it('is unreadable when it could not be read', () => {
    expect(checkInstallState(null, dana, now)).toBe('unreadable');
  });
});
