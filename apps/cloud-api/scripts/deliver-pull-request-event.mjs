// Fires a real pull request's GitHub event at a local cell, without GitHub's webhook or a tunnel:
// it reads the pull request with your own `gh`, builds the body GitHub would POST for a
// `pull_request` event, wraps it in the message cloud-global passes on to a cell, signs it the
// way cloud-global does (a compact JWS, `typ` GITHUB_EVENT_TYPE, with CELL_TOKEN_PRIVATE_KEY and
// its thumbprint as `kid`), and POSTs it to the cell's event route. Each run is a fresh delivery.
//
//   node apps/cloud-region/scripts/deliver-pull-request-event.mjs \
//     --repository <owner/name> --number <n> [--action opened] \
//     [--cell-url http://127.0.0.1:3101] [--workspace <id>] [--region eu|us] \
//     [--installation <id>] [--pull-request-json <file>] \
//     [--global-env <apps/cloud-global/.env>] [--region-env <apps/cloud-region/.env>]
//
// The key comes from apps/cloud-global/.env (CELL_TOKEN_PRIVATE_KEY); the workspace from
// RUNNER_WORKSPACE_ID, the region from REGION and the port from PORT in apps/cloud-region/.env,
// unless given. `--pull-request-json` reads the pull request from a file (what
// `gh api repos/<owner>/<name>/pulls/<n>` prints) instead of asking gh. It never prints a key.

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import {
  CELL_TOKEN_ALGORITHM,
  GITHUB_EVENT_DELIVERY_MEDIA_TYPE,
  GITHUB_EVENT_DELIVERY_PATH,
  GITHUB_EVENT_TYPE,
} from '@consola/cloud-contract';
import { CompactSign, calculateJwkThumbprint } from 'jose';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

function fail(message) {
  console.error(`deliver-pull-request-event: ${message}`);
  process.exit(1);
}

const { values: options } = parseArgs({
  options: {
    repository: { type: 'string' },
    number: { type: 'string' },
    action: { type: 'string', default: 'opened' },
    'cell-url': { type: 'string' },
    workspace: { type: 'string' },
    region: { type: 'string' },
    installation: { type: 'string', default: '1' },
    'pull-request-json': { type: 'string' },
    'global-env': { type: 'string', default: here('../../cloud-global/.env') },
    'region-env': { type: 'string', default: here('../.env') },
  },
});

const repository = options.repository ?? fail('--repository <owner/name> is required.');
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) fail('--repository is not owner/name.');
const number = Number(options.number ?? fail('--number <n> is required.'));
if (!Number.isInteger(number) || number < 1) fail('--number is not a pull request number.');
const installationId = Number(options.installation);
if (!Number.isInteger(installationId) || installationId < 1) {
  fail('--installation is not a whole number from 1.');
}

/** An env file's variables, or none when it is not there. Values are never printed. */
const envOf = (path) => (existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {});
const globalEnv = envOf(options['global-env']);
const regionEnv = envOf(options['region-env']);

const workspaceId =
  options.workspace ??
  regionEnv.RUNNER_WORKSPACE_ID ??
  fail(`--workspace is required: ${options['region-env']} sets no RUNNER_WORKSPACE_ID.`);
const region = options.region ?? regionEnv.REGION ?? 'eu';
const cellUrl = (options['cell-url'] ?? `http://127.0.0.1:${regionEnv.PORT ?? 3101}`).replace(
  /\/+$/,
  '',
);

// The key cloud-global signs with: an Ed25519 private JWK on one line.
const keyText =
  globalEnv.CELL_TOKEN_PRIVATE_KEY ??
  fail(`${options['global-env']} sets no CELL_TOKEN_PRIVATE_KEY.`);
let privateKey;
let kid;
try {
  const { kty, crv, x, d } = JSON.parse(keyText);
  privateKey = createPrivateKey({ key: { kty, crv, x, d }, format: 'jwk' });
  const derived = createPublicKey(privateKey).export({ format: 'jwk' });
  kid = await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: derived.x });
} catch {
  fail('CELL_TOKEN_PRIVATE_KEY is not an Ed25519 private JWK.');
}

// The pull request, as GitHub's REST API has it: the webhook's `pull_request` is the same object.
let pullRequest;
try {
  const text = options['pull-request-json']
    ? readFileSync(options['pull-request-json'], 'utf8')
    : execFileSync('gh', ['api', `repos/${repository}/pulls/${number}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 64 * 1024 * 1024,
      });
  pullRequest = JSON.parse(text);
} catch (error) {
  fail(
    `could not read ${repository}#${number}: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
  );
}

// The body GitHub POSTs for a `pull_request` event.
const payload = {
  action: options.action,
  number,
  pull_request: pullRequest,
  repository: pullRequest.base?.repo ?? { full_name: repository },
  sender: pullRequest.user,
  installation: { id: installationId },
};

// The message cloud-global passes on to the workspace's cell, and its signature.
const deliveryId = randomUUID();
const message = { workspaceId, region, deliveryId, event: 'pull_request', installationId, payload };
const delivery = await new CompactSign(new TextEncoder().encode(JSON.stringify(message)))
  .setProtectedHeader({ alg: CELL_TOKEN_ALGORITHM, kid, typ: GITHUB_EVENT_TYPE })
  .sign(privateKey);

console.log(
  `Delivering ${repository}#${number} (${options.action}) as delivery ${deliveryId} for workspace ${workspaceId} (${region}) to ${cellUrl}${GITHUB_EVENT_DELIVERY_PATH}`,
);
let response;
try {
  response = await fetch(`${cellUrl}${GITHUB_EVENT_DELIVERY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': GITHUB_EVENT_DELIVERY_MEDIA_TYPE },
    body: delivery,
  });
} catch (error) {
  fail(`the cell did not answer: ${error instanceof Error ? error.message : error}`);
}
console.log(`The cell answered ${response.status}: ${await response.text()}`);
process.exit(response.ok ? 0 : 1);
