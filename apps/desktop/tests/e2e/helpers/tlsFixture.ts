import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface TlsFixture {
  port: number;
  /** `https://127.0.0.1:<port>/`. */
  url: string;
  close(): Promise<void>;
}

/**
 * An HTTPS server on 127.0.0.1 with a self-signed certificate made for this
 * run (the system's `openssl`, two-day expiry, never written anywhere but a
 * temp folder that is removed on close), so the browser sees an authority it
 * does not know, which is what a local dev server presents.
 */
export async function startTlsFixture(): Promise<TlsFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-tls-'));
  const config = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name=dn',
      'x509_extensions=v3',
      'prompt=no',
      '[dn]',
      'CN=127.0.0.1',
      '[v3]',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      'basicConstraints=critical,CA:FALSE',
    ].join('\n'),
  );
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      key,
      '-out',
      cert,
      '-config',
      config,
    ],
    { stdio: 'ignore' },
  );

  const server = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Secure</title></head><body>secure</body></html>');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `https://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
