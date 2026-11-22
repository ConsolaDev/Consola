import {
  CELL_TOKEN_ALGORITHM,
  cellTokenClaims,
  OUTBOX_MESSAGE_TYPE,
  type OutboxMessage,
} from '@consola/cloud-contract';
import {
  CompactSign,
  type CompactJWSHeaderParameters,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  SignJWT,
} from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CellTokenKeys } from './cellTokens.js';
import { createJoseDeliveryVerifier } from './outboxDeliveries.js';

type SigningKey = { privateKey: CryptoKey; publicKey: CryptoKey; jwk: JWK; kid: string };

async function newSigningKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(CELL_TOKEN_ALGORITHM, {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return {
    privateKey,
    publicKey,
    jwk: { ...jwk, kid, alg: CELL_TOKEN_ALGORITHM, use: 'sig' },
    kid,
  };
}

let cloudGlobal: SigningKey;
let stranger: SigningKey;
let published: JSONWebKeySet;

beforeAll(async () => {
  cloudGlobal = await newSigningKey();
  stranger = await newSigningKey();
  published = { keys: [cloudGlobal.jwk] };
});

const message: OutboxMessage = {
  workspaceId: 'acme',
  region: 'eu',
  sequence: 1,
  change: { type: 'workspace.created' },
};

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** A delivery signed the way cloud-global signs one, with what a test changes. */
function signDelivery(
  payload: unknown = message,
  key: SigningKey = cloudGlobal,
  header: Partial<CompactJWSHeaderParameters> = {},
): Promise<string> {
  return new CompactSign(bytes(payload))
    .setProtectedHeader({
      alg: CELL_TOKEN_ALGORITHM,
      kid: key.kid,
      typ: OUTBOX_MESSAGE_TYPE,
      ...header,
    })
    .sign(key.privateKey);
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A verifier over `keys` whose reports are kept, not logged. */
function verifierOver(keys: CellTokenKeys) {
  const reports: string[] = [];
  return { reports, verifier: createJoseDeliveryVerifier(keys, (line) => reports.push(line)) };
}

describe('createJoseDeliveryVerifier', () => {
  it("hands back a good delivery's payload unread: reading it is the contract's", async () => {
    const { verifier, reports } = verifierOver(createLocalJWKSet(published));
    const odd = { ...message, email: 'dana@acme.test' };
    expect(await verifier.verify(await signDelivery(odd))).toEqual({
      kind: 'verified',
      payload: bytes(odd),
    });
    expect(reports).toEqual([]);
  });

  it.each<[string, () => Promise<string>, string]>([
    [
      "one signed by another key that names cloud-global's key",
      () => signDelivery(message, stranger, { kid: cloudGlobal.kid }),
      'its signature does not check',
    ],
    [
      'one signed by a key cloud-global does not publish',
      () => signDelivery(message, stranger),
      "no key in cloud-global's set has its kid",
    ],
    [
      'one whose payload was changed after signing',
      async () => {
        const [header, , signature] = (await signDelivery()).split('.');
        return [header, base64url({ ...message, workspaceId: 'sprocket' }), signature].join('.');
      },
      'its signature does not check',
    ],
    [
      'one with another typ',
      () => signDelivery(message, cloudGlobal, { typ: 'JWT' }),
      `its typ is not ${OUTBOX_MESSAGE_TYPE}`,
    ],
    [
      'one with no typ',
      () => signDelivery(message, cloudGlobal, { typ: undefined }),
      `its typ is not ${OUTBOX_MESSAGE_TYPE}`,
    ],
    [
      'a real cell token',
      () =>
        new SignJWT(
          cellTokenClaims({
            personId: 'person-dana',
            workspaceId: 'acme',
            role: 'owner',
            region: 'eu',
            issuedAt: Math.floor(Date.now() / 1000),
          }),
        )
          .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid: cloudGlobal.kid })
          .sign(cloudGlobal.privateKey),
      `its typ is not ${OUTBOX_MESSAGE_TYPE}`,
    ],
    [
      'one naming no key',
      () => signDelivery(message, cloudGlobal, { kid: undefined }),
      'it names no kid',
    ],
    [
      'one naming an empty key',
      () => signDelivery(message, cloudGlobal, { kid: '' }),
      'it names no kid',
    ],
    [
      "an HS256 one whose secret is cloud-global's public key",
      async () => {
        const secret = new TextEncoder().encode(await exportSPKI(cloudGlobal.publicKey));
        return new CompactSign(bytes(message))
          .setProtectedHeader({ alg: 'HS256', kid: cloudGlobal.kid, typ: OUTBOX_MESSAGE_TYPE })
          .sign(secret);
      },
      `its alg is not ${CELL_TOKEN_ALGORITHM}`,
    ],
    [
      'an unsigned one (alg: none)',
      async () =>
        `${base64url({ alg: 'none', kid: cloudGlobal.kid, typ: OUTBOX_MESSAGE_TYPE })}.${base64url(message)}.`,
      `its alg is not ${CELL_TOKEN_ALGORITHM}`,
    ],
    ['an empty body', async () => '', 'it is not a compact JWS (ERR_JWS_INVALID)'],
    [
      'the message unsigned',
      async () => JSON.stringify(message),
      'it is not a compact JWS (ERR_JWS_INVALID)',
    ],
    [
      'three parts that are no JWS',
      async () => 'a.b.c',
      'it is not a compact JWS (ERR_JWS_INVALID)',
    ],
  ])('refuses %s', async (_what, delivery, reason) => {
    const { verifier, reports } = verifierOver(createLocalJWKSet(published));
    expect(await verifier.verify(await delivery())).toEqual({ kind: 'unsigned', reason });
    expect(reports).toEqual([]);
  });

  it('refuses another typ or no kid without asking the key set', async () => {
    const keys = vi.fn(createLocalJWKSet(published));
    const { verifier } = verifierOver(keys);
    for (const header of [{ typ: 'JWT' }, { kid: undefined }, { kid: '' }]) {
      const check = await verifier.verify(await signDelivery(message, cloudGlobal, header));
      expect(check.kind).toBe('unsigned');
    }
    expect(keys).not.toHaveBeenCalled();
  });

  it('refuses every delivery while the key set fails, reporting why but never the delivery', async () => {
    const { verifier, reports } = verifierOver(async () => {
      throw new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:3100'),
      });
    });
    const delivery = await signDelivery();
    expect(await verifier.verify(delivery)).toEqual({ kind: 'keys-unavailable' });
    expect(reports).toEqual([
      "The cell could not get cloud-global's cell token keys: fetch failed: connect ECONNREFUSED 127.0.0.1:3100",
    ]);
    expect(reports.join('\n')).not.toContain(delivery);
  });
});
