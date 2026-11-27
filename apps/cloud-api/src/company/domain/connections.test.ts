import { describe, expect, it } from 'vitest';
import {
  administeredInstallations,
  candidateOf,
  checkInstallChoice,
  checkInstaller,
  checkInstallState,
  INSTALL_CHOICE_LIFETIME_SECONDS,
  INSTALL_STATE_LIFETIME_SECONDS,
  installationSettingsUrl,
  MAX_INSTALL_CANDIDATES,
  mayManageConnections,
  newInstallChoice,
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

describe('the installations a person who signed in may choose from', () => {
  const sprocket: GitHubInstallation = {
    id: 41,
    account: { id: 9001, login: 'sprocket', type: 'Organization' },
    repositorySelection: 'selected',
  };
  const acme: GitHubInstallation = {
    id: 52,
    account: { id: 9002, login: 'acme', type: 'Organization' },
    repositorySelection: 'all',
  };
  const own: GitHubInstallation = {
    id: 63,
    account: { id: 7, login: 'dana', type: 'User' },
    repositorySelection: 'all',
  };
  const someoneElses: GitHubInstallation = {
    id: 64,
    account: { id: 8, login: 'lee', type: 'User' },
    repositorySelection: 'all',
  };

  it('are those they administer, by the rule a fresh install has, in the order GitHub lists them', () => {
    expect(
      administeredInstallations([
        { installation: acme, gitHubUserId: 7, organizationRole: 'member' },
        { installation: own, gitHubUserId: 7, organizationRole: null },
        { installation: sprocket, gitHubUserId: 7, organizationRole: 'admin' },
        { installation: someoneElses, gitHubUserId: 7, organizationRole: null },
        { installation: null, gitHubUserId: 7, organizationRole: 'admin' },
      ]),
    ).toEqual([own, sprocket]);
  });

  it('are none when they administer none', () => {
    expect(
      administeredInstallations([{ installation: acme, gitHubUserId: 7, organizationRole: null }]),
    ).toEqual([]);
    expect(administeredInstallations([])).toEqual([]);
  });
});

describe('a choice of installation', () => {
  const now = 1_800_000_000;
  const dana = { personId: 'dana', sessionId: 'session-1' };
  const here = { ...dana, workspaceId: 'sprocket' };
  const sprocket = {
    id: 41,
    account: { id: 9001, login: 'sprocket', type: 'Organization' as const },
  };
  const own = { id: 63, account: { id: 7, login: 'dana', type: 'User' as const } };
  const choice = newInstallChoice(dana, 'sprocket', [sprocket, own], now);

  it('names the workspace, the person, the session and each candidate, for five minutes', () => {
    expect(choice).toEqual({
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-1',
      expiresAt: now + INSTALL_CHOICE_LIFETIME_SECONDS,
      candidates: [sprocket, own],
    });
    expect(INSTALL_CHOICE_LIFETIME_SECONDS).toBe(300);
  });

  it('keeps only the id and the account of an installation, and at most twenty', () => {
    const many: GitHubInstallation[] = Array.from({ length: 30 }, (_, n) => ({
      id: 1000 + n,
      account: { id: n + 1, login: `org-${n}`, type: 'Organization' },
      repositorySelection: 'all',
    }));
    const cut = newInstallChoice(dana, 'sprocket', many, now);
    expect(MAX_INSTALL_CANDIDATES).toBe(20);
    expect(cut.candidates).toHaveLength(20);
    expect(cut.candidates[0]).toEqual({
      id: 1000,
      account: { id: 1, login: 'org-0', type: 'Organization' },
    });
    expect(cut.candidates.at(-1)?.id).toBe(1019);
  });

  it('is made in the session that signed in, in time, in the workspace it has active', () => {
    expect(checkInstallChoice(choice, here, now + 1)).toBe('ok');
    expect(checkInstallChoice(choice, here, choice.expiresAt - 1)).toBe('ok');
  });

  it('is expired from the second it ends', () => {
    expect(checkInstallChoice(choice, here, choice.expiresAt)).toBe('expired');
  });

  it("is refused in another session, the person's own included", () => {
    expect(checkInstallChoice(choice, { ...here, sessionId: 'session-2' }, now)).toBe(
      'not-this-session',
    );
    expect(checkInstallChoice(choice, { ...here, personId: 'eli' }, now)).toBe('not-this-session');
  });

  it('is refused once the session has another workspace active', () => {
    expect(checkInstallChoice(choice, { ...here, workspaceId: 'acme' }, now)).toBe(
      'other-workspace',
    );
  });

  it('is unreadable when it could not be read', () => {
    expect(checkInstallChoice(null, here, now)).toBe('unreadable');
  });

  it('offers only its own candidates', () => {
    expect(candidateOf(choice, 41)).toEqual(sprocket);
    expect(candidateOf(choice, 63)).toEqual(own);
    expect(candidateOf(choice, 52)).toBeNull();
  });
});
