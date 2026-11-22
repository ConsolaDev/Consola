import {
  fieldProblem,
  isId,
  isRecord,
  isWholeNumber,
  type ReadResult,
  read,
  refused,
} from './read.js';
import { isRegion, type Region } from './region.js';
import { isWorkspaceRole, type WorkspaceRole } from './workspaceRole.js';

/**
 * The token `cloud-global` mints for a cell, once it has checked the browser's sign-in and the
 * person's membership: a JWT, signed with Ed25519, that says who is asking, in which workspace,
 * with which role, in which region, and until when. A cell checks the signature with
 * `cloud-global`'s public key, allowing only this algorithm, then reads the claims with
 * `readCellTokenClaims`. Signing and checking signatures are the apps' work; this package holds
 * only what the two agree on.
 */
export const CELL_TOKEN_ALGORITHM = 'EdDSA';

/**
 * The audience every cell token names. A token minted with the same key for anything else (a
 * session's pass, say) names another, so a cell never takes it for one of its own.
 */
export const CELL_TOKEN_AUDIENCE = 'consola-cell';

/**
 * How long a token lives. Minutes, so a person removed from a workspace, or given another role,
 * keeps what the old token says for no longer than this.
 */
export const CELL_TOKEN_LIFETIME_SECONDS = 5 * 60;

/** How far apart the clocks of `cloud-global` and a cell may be. */
export const CLOCK_SKEW_SECONDS = 30;

/** The claims of a cell token, by their JWT names. Times are whole seconds since the epoch. */
export type CellTokenClaims = {
  /** Always `CELL_TOKEN_AUDIENCE`. */
  aud: typeof CELL_TOKEN_AUDIENCE;
  /** The person: their global id, the one `cloud-global` gives them. Never an email. */
  sub: string;
  /** The workspace: its id in `cloud-global`. */
  ws: string;
  /** The person's role in the workspace when the token was minted. */
  role: WorkspaceRole;
  /** The workspace's region. A cell refuses a token for a workspace in another region. */
  region: Region;
  /** When it was minted. */
  iat: number;
  /** When it expires: at most `CELL_TOKEN_LIFETIME_SECONDS` after `iat`. */
  exp: number;
};

const CLAIMS = ['aud', 'sub', 'ws', 'role', 'region', 'iat', 'exp'] as const;

/** What `cloud-global` mints a token for, in its own words. */
export type CellTokenGrant = {
  personId: string;
  workspaceId: string;
  role: WorkspaceRole;
  region: Region;
  /** The time it mints the token, in whole seconds since the epoch. */
  issuedAt: number;
};

/**
 * The claims `cloud-global` signs for a grant, expiring `CELL_TOKEN_LIFETIME_SECONDS` after it is
 * minted. It throws on a grant a cell would refuse (an empty id, a role or a region the contract
 * does not name, a time that is not whole seconds), so no such token is ever minted.
 */
export function cellTokenClaims(grant: CellTokenGrant): CellTokenClaims {
  const claims = {
    aud: CELL_TOKEN_AUDIENCE,
    sub: grant.personId,
    ws: grant.workspaceId,
    role: grant.role,
    region: grant.region,
    iat: grant.issuedAt,
    exp: grant.issuedAt + CELL_TOKEN_LIFETIME_SECONDS,
  };
  const checked = readCellTokenClaims(claims, grant.issuedAt);
  if (!checked.ok) throw new TypeError(`No cell token can be minted for this: ${checked.reason}.`);
  return checked.value;
}

/**
 * Reads the claims of a token whose signature has already been checked, at `nowSeconds` (whole
 * seconds since the epoch, from the cell's clock). It refuses claims of any other shape (a claim
 * missing, or one the contract does not name), a token meant for something else, one that lives
 * longer than a cell token may, one minted in the future and one that has expired, each
 * allowing `CLOCK_SKEW_SECONDS` between the clocks. Whether the region is the cell's own is the
 * cell's to check.
 */
export function readCellTokenClaims(
  payload: unknown,
  nowSeconds: number,
): ReadResult<CellTokenClaims> {
  // NaN would compare false with every time, so a token would never expire.
  if (!Number.isFinite(nowSeconds))
    throw new TypeError('The time to read a token at is not a number.');
  if (!isRecord(payload)) return refused("the token's claims are not an object");
  const fields = fieldProblem(payload, CLAIMS, 'the token');
  if (fields !== null) return refused(fields);

  const { aud, sub, ws, role, region, iat, exp } = payload;
  if (aud !== CELL_TOKEN_AUDIENCE) return refused('the token is not meant for a cell (`aud`)');
  if (!isId(sub)) return refused("`sub` is not a person's id");
  if (!isId(ws)) return refused("`ws` is not a workspace's id");
  if (!isWorkspaceRole(role)) return refused('`role` is not a workspace role');
  if (!isRegion(region)) return refused('`region` is not a region');
  if (!isWholeNumber(iat) || iat < 0) return refused('`iat` is not a time in whole seconds');
  if (!isWholeNumber(exp) || exp < 0) return refused('`exp` is not a time in whole seconds');
  if (exp <= iat) return refused('the token expires before it was minted');
  if (exp - iat > CELL_TOKEN_LIFETIME_SECONDS) {
    return refused('the token lives longer than a cell token may');
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return refused('the token was minted in the future');
  if (nowSeconds >= exp + CLOCK_SKEW_SECONDS) return refused('the token has expired');
  return read({ aud, sub, ws, role, region, iat, exp });
}
