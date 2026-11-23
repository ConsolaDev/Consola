import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_KEYS_PATH,
  CELL_TOKEN_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS,
  cellTokenClaims,
  GITHUB_EVENT_TYPE,
  OUTBOX_MESSAGE_TYPE,
} from '@consola/cloud-contract';
import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  type JWTHeaderParameters,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type CellTokenKeys, cloudGlobalKeys, createJoseTokenVerifier } from './cellTokens.js';

const NOW = 1_800_000_000;

type SigningKey = { privateKey: CryptoKey; jwk: JWK; kid: string };

async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(CELL_TOKEN_ALGORITHM, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { privateKey, jwk: { ...jwk, kid, alg: CELL_TOKEN_ALGORITHM, use: 'sig' }, kid };
}

let cloudGlobal: SigningKey;
let stranger: SigningKey;
let published: JSONWebKeySet;

beforeAll(async () => {
  cloudGlobal = await newSigningKey();
  stranger = await newSigningKey();
  published = { keys: [cloudGlobal.jwk] };
});

const claims = (): Record<string, unknown> =>
  cellTokenClaims({
    personId: 'person-1',
    workspaceId: 'acme',
    role: 'member',
    region: 'eu',
    issuedAt: NOW,
  });

function sign(
  payload: Record<string, unknown> = claims(),
  key: SigningKey = cloudGlobal,
  header: Partial<JWTHeaderParameters> = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid: key.kid, ...header })
    .sign(key.privateKey);
}

/** A verifier over `keys` whose reports are kept, not logged. */
function verifierOver(keys: CellTokenKeys) {
  const reports: string[] = [];
  return { reports, verifier: createJoseTokenVerifier(keys, (line) => reports.push(line)) };
}

/** A server on a port of its own, answering every request with `answer`. */
async function serve(answer: (response: ServerResponse) => void) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (body: unknown) => (response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

describe('createJoseTokenVerifier', () => {
  it("hands back a good token's claims unread: reading them is the contract's", async () => {
    const { verifier } = verifierOver(createLocalJWKSet(published));
    const payload = { ...claims(), email: 'someone@sprocket.test' };
    expect(await verifier.verify(await sign(payload), NOW)).toEqual({
      kind: 'verified',
      payload,
    });
  });

  it('judges the times at the moment it is given, allowing the skew, as the reader does', async () => {
    const { verifier } = verifierOver(createLocalJWKSet(published));
    const token = await sign();
    const expiry = NOW + CELL_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS;
    expect((await verifier.verify(token, expiry - 1)).kind).toBe('verified');
    expect(await verifier.verify(token, expiry)).toEqual({ kind: 'invalid' });
  });

  it('refuses a token that names no key without asking the key set', async () => {
    const keys = vi.fn(createLocalJWKSet(published));
    const { verifier } = verifierOver(keys);
    for (const kid of [undefined, '']) {
      expect(await verifier.verify(await sign(claims(), cloudGlobal, { kid }), NOW)).toEqual({
        kind: 'invalid',
      });
    }
    expect(keys).not.toHaveBeenCalled();
  });

  it("refuses a delivery's typ without asking the key set, whatever it holds", async () => {
    const keys = vi.fn(createLocalJWKSet(published));
    const { verifier } = verifierOver(keys);
    for (const typ of [OUTBOX_MESSAGE_TYPE, GITHUB_EVENT_TYPE]) {
      const delivery = await sign(claims(), cloudGlobal, { typ });
      expect([typ, await verifier.verify(delivery, NOW)]).toEqual([typ, { kind: 'invalid' }]);
    }
    expect(keys).not.toHaveBeenCalled();
    // Any other typ is no concern of the token check.
    expect(
      (await verifier.verify(await sign(claims(), cloudGlobal, { typ: 'JWT' }), NOW)).kind,
    ).toBe('verified');
  });

  it('refuses a token naming a key the set does not hold', async () => {
    const { verifier, reports } = verifierOver(createLocalJWKSet(published));
    expect(await verifier.verify(await sign(claims(), stranger), NOW)).toEqual({
      kind: 'invalid',
    });
    expect(reports).toEqual([]);
  });

  it('refuses every token while the key set fails, reporting why but never the token', async () => {
    const { verifier, reports } = verifierOver(async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:3100'),
      });
    });
    const token = await sign();
    expect(await verifier.verify(token, NOW)).toEqual({ kind: 'keys-unavailable' });
    expect(reports).toEqual([
      "The cell could not get cloud-global's cell token keys: fetch failed: connect ECONNREFUSED 127.0.0.1:3100",
    ]);
    expect(reports.join('\n')).not.toContain(token);
  });
});

describe("cloudGlobalKeys, cloud-global's key set", () => {
  it('is fetched from CELL_TOKEN_KEYS_PATH on its origin, and kept', async () => {
    const global = await serve(json(published));
    const { verifier } = verifierOver(cloudGlobalKeys(global.url));
    expect((await verifier.verify(await sign(), NOW)).kind).toBe('verified');
    expect((await verifier.verify(await sign(), NOW)).kind).toBe('verified');
    expect(global.requests).toEqual([`GET ${CELL_TOKEN_KEYS_PATH}`]);
    await global.close();
  });

  it('that answers with no key set lets nothing through', async () => {
    for (const body of [{ keys: 'none' }, { error: 'internal' }, 'not json']) {
      const global = await serve((response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(typeof body === 'string' ? body : JSON.stringify(body));
      });
      const { verifier, reports } = verifierOver(cloudGlobalKeys(global.url));
      expect(await verifier.verify(await sign(), NOW)).toEqual({ kind: 'keys-unavailable' });
      expect(reports).toHaveLength(1);
      await global.close();
    }
  });

  it('is never taken from where a redirect points', async () => {
    // Elsewhere publishes a key of its own, which a token it signed names.
    const elsewhere = await serve(json({ keys: [stranger.jwk] }));
    const global = await serve((response) => {
      response.writeHead(302, { location: `${elsewhere.url}${CELL_TOKEN_KEYS_PATH}` }).end();
    });
    const { verifier } = verifierOver(cloudGlobalKeys(global.url));
    expect(await verifier.verify(await sign(claims(), stranger), NOW)).toEqual({
      kind: 'keys-unavailable',
    });
    expect(elsewhere.requests).toEqual([]);
    await global.close();
    await elsewhere.close();
  });
});
