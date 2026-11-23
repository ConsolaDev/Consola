// @effect-diagnostics nodeBuiltinImport:off - The tests' pass keys are files on their machine.
// @effect-diagnostics globalDate:off - A pass is signed in Node for a test, outside any Effect runtime.
/**
 * The browser tests' stand-in for the cell (Node only): an Ed25519 key pair made for the run, the
 * replay host started with its public key (`hostSession.ts`), and passes signed with its private
 * key, as the cell signs them (an EdDSA compact JWS, `typ` `PASS_TYPE`, of the protocol's claims,
 * `passClaims`: `aud`, `sub`, `ws`, `sid`, `iat`, `exp`, living `PASS_MAX_LIFETIME_SECONDS` at
 * most; `@consola/host`'s `src/core/pass.ts`). A test asks for one through the `signHostPass`
 * browser command (`vite.config.ts`). No key is committed.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { PASS_TYPE, passClaims } from '@consola/host/src/testing/cellPass.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PassKeyFiles = {
  /** The public key, SPKI PEM: the host's `--pass-public-key`. */
  readonly publicKeyFile: string;
  /** The private key, PKCS #8 PEM, readable by its owner only. */
  readonly privateKeyFile: string;
};

/** Makes a key pair and writes it into `dir`. */
export const writePassKeys = (dir: string): PassKeyFiles => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const files = {
    publicKeyFile: join(dir, 'pass-public.pem'),
    privateKeyFile: join(dir, 'pass-private.pem'),
  };
  writeFileSync(files.publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(files.privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  return files;
};

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A pass for `sessionId` that expires `lifetimeSeconds` from now (at most the protocol's cap:
 * `passClaims` throws over it).
 */
export const signPass = (
  privateKeyFile: string,
  sessionId: string,
  lifetimeSeconds: number,
): string => {
  const claims = passClaims({
    personId: 'person-acme-1',
    workspaceId: 'workspace-sprocket',
    sessionId,
    issuedAt: Math.floor(Date.now() / 1000),
    lifetimeSeconds,
  });
  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: PASS_TYPE }));
  const payload = base64url(JSON.stringify(claims));
  const key = createPrivateKey(readFileSync(privateKeyFile));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
};
