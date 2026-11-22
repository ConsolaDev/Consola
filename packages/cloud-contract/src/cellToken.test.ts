import { describe, expect, it } from 'vitest';
import {
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS,
  type CellTokenGrant,
  cellTokenClaims,
  readCellTokenClaims,
} from './cellToken.js';

const MINTED = 1_800_000_000;

const grant: CellTokenGrant = {
  personId: 'person-dana',
  workspaceId: 'workspace-sprocket',
  role: 'admin',
  region: 'eu',
  issuedAt: MINTED,
};

const claims = cellTokenClaims(grant);

/** The claims with one changed, or removed when `value` is undefined. */
function withClaim(name: string, value: unknown): Record<string, unknown> {
  const changed: Record<string, unknown> = { ...claims, [name]: value };
  if (value === undefined) delete changed[name];
  return changed;
}

const reasonFor = (payload: unknown, now = MINTED): string | null => {
  const result = readCellTokenClaims(payload, now);
  return result.ok ? null : result.reason;
};

describe('cellTokenClaims', () => {
  it('names the person, workspace, role, region and the cell audience, by their JWT names', () => {
    expect(claims).toEqual({
      aud: CELL_TOKEN_AUDIENCE,
      sub: 'person-dana',
      ws: 'workspace-sprocket',
      role: 'admin',
      region: 'eu',
      iat: MINTED,
      exp: MINTED + CELL_TOKEN_LIFETIME_SECONDS,
    });
  });

  it('expires within minutes', () => {
    expect(CELL_TOKEN_LIFETIME_SECONDS).toBeGreaterThan(0);
    expect(CELL_TOKEN_LIFETIME_SECONDS).toBeLessThanOrEqual(15 * 60);
  });

  it.each([
    ['an empty person id', { personId: '' }],
    ['an empty workspace id', { workspaceId: '' }],
    ['a role the contract does not name', { role: 'superuser' }],
    ['a region the contract does not name', { region: 'ap' }],
    ['a time in milliseconds, or any fraction', { issuedAt: MINTED + 0.5 }],
    ['a time before the epoch', { issuedAt: -1 }],
  ])('throws rather than mint a token a cell would refuse: %s', (_case, change) => {
    expect(() => cellTokenClaims({ ...grant, ...change } as CellTokenGrant)).toThrow(TypeError);
  });
});

describe('readCellTokenClaims', () => {
  it('reads the claims cloud-global mints, after they cross as JSON', () => {
    expect(readCellTokenClaims(JSON.parse(JSON.stringify(claims)), MINTED)).toEqual({
      ok: true,
      value: claims,
    });
  });

  it.each(['owner', 'admin', 'member'])('reads a token for the role %s', (role) => {
    expect(readCellTokenClaims(withClaim('role', role), MINTED).ok).toBe(true);
  });

  it.each([null, 'token', 42, [claims]])('refuses claims that are not an object: %j', (payload) => {
    expect(reasonFor(payload)).toBe("the token's claims are not an object");
  });

  it.each(['aud', 'sub', 'ws', 'role', 'region', 'iat', 'exp'])(
    'refuses a token without %s',
    (name) => {
      expect(reasonFor(withClaim(name, undefined))).toBe(`the token has no \`${name}\``);
    },
  );

  it.each([
    ['an email', 'email', 'dana@sprocket.test'],
    ['a not-before time', 'nbf', MINTED],
    ['an issuer', 'iss', 'cloud-global'],
  ])('refuses a claim the contract does not name: %s', (_case, name, value) => {
    expect(reasonFor(withClaim(name, value))).toBe(
      `the token has \`${name}\`, which the contract does not name`,
    );
  });

  it.each([
    [
      'another audience',
      'aud',
      'consola-session-host',
      'the token is not meant for a cell (`aud`)',
    ],
    ['an audience list', 'aud', [CELL_TOKEN_AUDIENCE], 'the token is not meant for a cell (`aud`)'],
    ['an empty person', 'sub', '', "`sub` is not a person's id"],
    ['a person that is no string', 'sub', 7, "`sub` is not a person's id"],
    ['an empty workspace', 'ws', '', "`ws` is not a workspace's id"],
    ['an unknown role', 'role', 'superuser', '`role` is not a workspace role'],
    ['several roles', 'role', 'admin,member', '`role` is not a workspace role'],
    ['an unknown region', 'region', 'ap', '`region` is not a region'],
    ['a fraction of a second', 'iat', MINTED + 0.5, '`iat` is not a time in whole seconds'],
    ['a time as a string', 'iat', String(MINTED), '`iat` is not a time in whole seconds'],
    ['a time before the epoch', 'iat', -1, '`iat` is not a time in whole seconds'],
    ['an expiry as a string', 'exp', 'soon', '`exp` is not a time in whole seconds'],
    ['an expiry no number can hold', 'exp', 2 ** 60, '`exp` is not a time in whole seconds'],
  ])('refuses %s', (_case, name, value, reason) => {
    expect(reasonFor(withClaim(name, value))).toBe(reason);
  });

  it('refuses a token that expires as it is minted, or before', () => {
    expect(reasonFor(withClaim('exp', MINTED))).toBe('the token expires before it was minted');
    expect(reasonFor(withClaim('exp', MINTED - 1))).toBe('the token expires before it was minted');
  });

  it('refuses a token that lives longer than a cell token may, even when signed', () => {
    const longer = withClaim('exp', MINTED + CELL_TOKEN_LIFETIME_SECONDS + 1);
    expect(reasonFor(longer)).toBe('the token lives longer than a cell token may');
    expect(readCellTokenClaims(withClaim('exp', MINTED + 60), MINTED).ok).toBe(true);
  });

  it('allows a cell clock behind cloud-global by up to the skew, and no further', () => {
    expect(reasonFor(claims, MINTED - CLOCK_SKEW_SECONDS)).toBeNull();
    expect(reasonFor(claims, MINTED - CLOCK_SKEW_SECONDS - 1)).toBe(
      'the token was minted in the future',
    );
  });

  it('expires the token at exp, allowing the skew', () => {
    const exp = MINTED + CELL_TOKEN_LIFETIME_SECONDS;
    expect(reasonFor(claims, exp - 1)).toBeNull();
    expect(reasonFor(claims, exp + CLOCK_SKEW_SECONDS - 1)).toBeNull();
    expect(reasonFor(claims, exp + CLOCK_SKEW_SECONDS)).toBe('the token has expired');
    expect(reasonFor(claims, exp + 24 * 60 * 60)).toBe('the token has expired');
  });

  it('throws when the time it reads at is no number, rather than never expire a token', () => {
    expect(() => readCellTokenClaims(claims, Number.NaN)).toThrow(TypeError);
    expect(() => readCellTokenClaims(claims, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it.each(['aud', 'role', 'region', 'iat', 'exp'])(
    'never puts what %s held in its reason',
    (name) => {
      const held = 'dana@sprocket.test';
      const reason = reasonFor(withClaim(name, held));
      expect(reason).not.toBeNull();
      expect(reason).not.toContain(held);
    },
  );
});
