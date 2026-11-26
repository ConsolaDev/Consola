import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CLOCK_SKEW_SECONDS,
  cellTokenClaims,
  GITHUB_EVENT_TYPE,
  OUTBOX_MESSAGE_TYPE,
  readCellTokenClaims,
  readGitHubEventMessage,
  readOutboxMessage,
} from '@consola/cloud-contract';
import type { GitHubEventMessage, OutboxMessage } from '@consola/cloud-contract';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../config.js';
import type { Ed25519PrivateJwk } from '../../config.js';
import { createCellTokenSigner } from './cellTokenSigner.js';

/** A key made for this run only, never one written down. */
function newKey(): Ed25519PrivateJwk {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }) as Ed25519PrivateJwk;
}

/** The RFC 7638 thumbprint of an Ed25519 public key, worked out by hand. */
function thumbprintOf(x: string): string {
  const canonical = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x });
  return createHash('sha256').update(canonical).digest('base64url');
}

const issuedAt = 1_795_000_000;
const claims = cellTokenClaims({
  personId: 'dana',
  workspaceId: 'acme',
  role: 'admin',
  region: 'us',
  issuedAt,
});

const message: OutboxMessage = {
  workspaceId: 'acme-workspace',
  region: 'eu',
  sequence: 2,
  change: { type: 'member.added', personId: 'person-dana', role: 'owner' },
};

/** Checks a token the way a cell does: the published keys, EdDSA alone, the cell's audience. */
async function verify(token: string, keys: Parameters<typeof createLocalJWKSet>[0]) {
  return jwtVerify(token, createLocalJWKSet(keys), {
    algorithms: [CELL_TOKEN_ALGORITHM],
    audience: CELL_TOKEN_AUDIENCE,
    clockTolerance: CLOCK_SKEW_SECONDS,
    currentDate: new Date(issuedAt * 1000),
  });
}

describe('createCellTokenSigner', () => {
  it('signs the claims, and nothing else, as a token its published key checks', async () => {
    const signer = await createCellTokenSigner(newKey());
    const token = await signer.sign(claims);
    const [published] = signer.publicKeys().keys;

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'EdDSA', kid: published?.kid });
    const { payload } = await verify(token, signer.publicKeys());
    expect(payload).toEqual(claims);
    expect(readCellTokenClaims(payload, issuedAt)).toEqual({ ok: true, value: claims });
  });

  it('publishes the public key, named by its thumbprint, and never its private part', async () => {
    const key = newKey();
    const keys = (await createCellTokenSigner(key)).publicKeys();

    expect(keys).toEqual({
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          x: key.x,
          kid: thumbprintOf(key.x),
          alg: 'EdDSA',
          use: 'sig',
        },
      ],
    });
    expect(keys.keys[0]).not.toHaveProperty('d');
    expect(JSON.stringify(keys)).not.toContain(key.d);
  });

  it('publishes a copy, so changing one changes nothing published', async () => {
    const signer = await createCellTokenSigner(newKey());
    const before = signer.publicKeys();
    const changed = signer.publicKeys();
    changed.keys.push({ ...before.keys[0], kid: 'sprocket' });
    if (changed.keys[0]) changed.keys[0].x = 'sprocket';

    expect(signer.publicKeys()).toEqual(before);
  });

  it("does not check another key's tokens", async () => {
    const ours = await createCellTokenSigner(newKey());
    const theirs = await createCellTokenSigner(newKey());
    await expect(verify(await theirs.sign(claims), ours.publicKeys())).rejects.toThrow();
  });

  it('signs an outbox message as a compact JWS its published key checks, typed as one', async () => {
    const signer = await createCellTokenSigner(newKey());
    const jws = await signer.signOutboxMessage(message);
    const [published] = signer.publicKeys().keys;

    // Compact serialization: three parts, the payload in the open, nothing detached.
    expect(jws.split('.')).toHaveLength(3);
    const { payload, protectedHeader } = await compactVerify(
      jws,
      createLocalJWKSet(signer.publicKeys()),
      { algorithms: [CELL_TOKEN_ALGORITHM] },
    );
    expect(protectedHeader).toEqual({
      alg: 'EdDSA',
      kid: published?.kid,
      typ: OUTBOX_MESSAGE_TYPE,
    });
    expect(OUTBOX_MESSAGE_TYPE).toBe('consola-outbox-message');
    // The payload is the message's JSON, exactly: ids and a role, nothing else about Dana.
    const text = new TextDecoder().decode(payload);
    expect(text).toBe(
      '{"workspaceId":"acme-workspace","region":"eu","sequence":2,"change":{"type":"member.added","personId":"person-dana","role":"owner"}}',
    );
    expect(readOutboxMessage(JSON.parse(text))).toEqual({ ok: true, value: message });
  });

  it('a signed message is no cell token, and a cell token is no message', async () => {
    const signer = await createCellTokenSigner(newKey());
    const jws = await signer.signOutboxMessage(message);
    const token = await signer.sign(claims);

    // A cell checking a token wants its audience, which no message names.
    await expect(verify(jws, signer.publicKeys())).rejects.toThrow();
    // A cell checking a message wants its `typ`, which no token carries.
    expect(decodeProtectedHeader(token).typ).toBeUndefined();
    const { payload } = await compactVerify(token, createLocalJWKSet(signer.publicKeys()));
    expect(readOutboxMessage(JSON.parse(new TextDecoder().decode(payload))).ok).toBe(false);
  });

  it("does not check another key's messages", async () => {
    const ours = await createCellTokenSigner(newKey());
    const theirs = await createCellTokenSigner(newKey());
    await expect(
      compactVerify(await theirs.signOutboxMessage(message), createLocalJWKSet(ours.publicKeys())),
    ).rejects.toThrow();
  });

  it('signs a GitHub event as a compact JWS its published key checks, typed as one', async () => {
    const signer = await createCellTokenSigner(newKey());
    const event: GitHubEventMessage = {
      workspaceId: 'sprocket-workspace',
      region: 'us',
      deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event: 'pull_request',
      installationId: 41,
      payload: { action: 'opened', number: 7, installation: { id: 41 } },
    };
    const jws = await signer.signGitHubEvent(event);
    const [published] = signer.publicKeys().keys;

    expect(jws.split('.')).toHaveLength(3);
    const { payload, protectedHeader } = await compactVerify(
      jws,
      createLocalJWKSet(signer.publicKeys()),
      { algorithms: [CELL_TOKEN_ALGORITHM] },
    );
    expect(protectedHeader).toEqual({ alg: 'EdDSA', kid: published?.kid, typ: GITHUB_EVENT_TYPE });
    const text = new TextDecoder().decode(payload);
    expect(readGitHubEventMessage(JSON.parse(text))).toEqual({ ok: true, value: event });
    // An event is no outbox message, and no cell token either.
    expect(readOutboxMessage(JSON.parse(text)).ok).toBe(false);
    await expect(verify(jws, signer.publicKeys())).rejects.toThrow();
  });

  it('refuses a key whose `x` is not the public key of its `d`, without quoting it', async () => {
    const key = { ...newKey(), x: newKey().x };
    const failure = await createCellTokenSigner(key).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConfigError);
    const { problems, message } = failure as ConfigError;
    expect(problems).toEqual([expect.stringMatching(/^CELL_TOKEN_PRIVATE_KEY: /)]);
    expect(message).not.toContain(key.d);
    expect(message).not.toContain(key.x);
  });
});
