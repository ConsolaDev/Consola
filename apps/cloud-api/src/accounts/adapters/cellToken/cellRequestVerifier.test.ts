import { generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  GITHUB_TOKEN_REQUEST_TYPE,
  gitHubTokenRequest,
  OUTBOX_MESSAGE_TYPE,
} from '@consola/cloud-contract';
import { CompactSign, calculateJwkThumbprint, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Ed25519PrivateJwk, Ed25519PublicJwk } from '../../config.js';
import { createCellRequestVerifier } from './cellRequestVerifier.js';
import { createCellTokenSigner } from './cellTokenSigner.js';

// Keys made for this run only, never written down: one per cell, and one no cell has.
const pairOf = () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { x } = privateKey.export({ format: 'jwk' });
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: x as string };
  return { privateKey, publicJwk };
};
const euCell = pairOf();
const usCell = pairOf();
const stranger = pairOf();

const request = gitHubTokenRequest({
  workspaceId: 'acme',
  installationId: 41,
  purpose: 'factory-pull',
  repositoryIds: [410],
  issuedAt: 1_800_000_000,
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The request signed as a cell signs it, with whatever header a test wants. */
async function signed(
  key: KeyObject,
  header: Record<string, unknown> = {},
  payload: Uint8Array = encode(request),
) {
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: key.export({ format: 'jwk' }).x as string };
  const kid = await calculateJwkThumbprint(publicJwk);
  return new CompactSign(payload)
    .setProtectedHeader({
      alg: CELL_TOKEN_ALGORITHM,
      kid,
      typ: GITHUB_TOKEN_REQUEST_TYPE,
      ...header,
    })
    .sign(key);
}

const verifier = await createCellRequestVerifier({ eu: euCell.publicJwk, us: usCell.publicJwk });

describe("a cell's signed request for a GitHub token", () => {
  it('is the payload, and the region of the cell whose key checks it', async () => {
    expect(await verifier.verifyTokenRequest(await signed(euCell.privateKey))).toEqual({
      kind: 'signed',
      region: 'eu',
      payload: request,
    });
    expect(await verifier.verifyTokenRequest(await signed(usCell.privateKey))).toEqual({
      kind: 'signed',
      region: 'us',
      payload: request,
    });
  });

  it('passes a payload that is not JSON on as nothing, for the reader to refuse', async () => {
    const answer = await verifier.verifyTokenRequest(
      await signed(euCell.privateKey, {}, new TextEncoder().encode('not json')),
    );
    expect(answer).toEqual({ kind: 'signed', region: 'eu', payload: undefined });
  });

  it('is unsigned with a key no cell has', async () => {
    expect(await verifier.verifyTokenRequest(await signed(stranger.privateKey))).toEqual({
      kind: 'unsigned',
    });
  });

  it("is unsigned when one cell's kid names another's signature", async () => {
    const usKid = await calculateJwkThumbprint(usCell.publicJwk);
    expect(
      await verifier.verifyTokenRequest(await signed(euCell.privateKey, { kid: usKid })),
    ).toEqual({ kind: 'unsigned' });
  });

  it('is unsigned once a byte of it changes', async () => {
    const good = await signed(euCell.privateKey);
    const [header, payload, signature] = good.split('.');
    const changed = encode({ ...request, repositoryIds: [411] });
    const forged = `${header}.${Buffer.from(changed).toString('base64url')}.${signature}`;
    expect(payload).not.toBe(forged.split('.')[1]);
    expect(await verifier.verifyTokenRequest(forged)).toEqual({ kind: 'unsigned' });
  });

  it.each([
    ['no typ', { typ: undefined }],
    ["the outbox's typ", { typ: OUTBOX_MESSAGE_TYPE }],
    ['a JWT typ', { typ: 'JWT' }],
    ['no kid', { kid: undefined }],
  ])('is unsigned with %s, before any key is tried', async (_case, header) => {
    expect(await verifier.verifyTokenRequest(await signed(euCell.privateKey, header))).toEqual({
      kind: 'unsigned',
    });
  });

  it('is unsigned with another algorithm, even one a key could check', async () => {
    const hmac = new TextEncoder().encode('a-secret-anyone-could-guess-for-hs256');
    const kid = await calculateJwkThumbprint(euCell.publicJwk);
    const token = await new CompactSign(encode(request))
      .setProtectedHeader({ alg: 'HS256', kid, typ: GITHUB_TOKEN_REQUEST_TYPE })
      .sign(hmac);
    expect(await verifier.verifyTokenRequest(token)).toEqual({ kind: 'unsigned' });
  });

  it.each(['', 'not-a-jws', 'a.b', 'a.b.c', 'a.b.c.d.e'])('is unsigned for %j', async (value) => {
    expect(await verifier.verifyTokenRequest(value)).toEqual({ kind: 'unsigned' });
  });

  it('is unsigned for what cloud-global signs itself: a cell token or an outbox message', async () => {
    const ownJwk = generateKeyPairSync('ed25519').privateKey.export({
      format: 'jwk',
    }) as Ed25519PrivateJwk;
    const own = await createCellTokenSigner(ownJwk);
    const token = await own.sign({
      aud: 'consola-cell',
      sub: 'person-dana',
      ws: 'acme',
      role: 'owner',
      region: 'eu',
      iat: 1_800_000_000,
      exp: 1_800_000_300,
    });
    expect(await verifier.verifyTokenRequest(token)).toEqual({ kind: 'unsigned' });
    const message = await own.signOutboxMessage({
      workspaceId: 'acme',
      region: 'eu',
      sequence: 1,
      change: { type: 'workspace.created' },
    });
    expect(await verifier.verifyTokenRequest(message)).toEqual({ kind: 'unsigned' });
  });

  it('is unsigned for every request when no cell has a key', async () => {
    const none = await createCellRequestVerifier({});
    expect(await none.verifyTokenRequest(await signed(euCell.privateKey))).toEqual({
      kind: 'unsigned',
    });
  });

  it('is unsigned for a JWT a cell signed for something else', async () => {
    const kid = await calculateJwkThumbprint(euCell.publicJwk);
    const jwt = await new SignJWT({ ...request })
      .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid })
      .sign(euCell.privateKey);
    expect(await verifier.verifyTokenRequest(jwt)).toEqual({ kind: 'unsigned' });
  });
});
