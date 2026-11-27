// Fires a real pull request's GitHub event at the API on this machine, without GitHub or a
// tunnel: it reads the pull request with your own `gh`, builds the body GitHub POSTs for a
// `pull_request` event, signs it as GitHub signs a webhook delivery (`X-Hub-Signature-256`, the
// HMAC-SHA256 of the body under GITHUB_WEBHOOK_SECRET), and POSTs it to the API's webhook route
// with a fresh `X-GitHub-Delivery`. Each run is a new delivery.
//
//   node apps/cloud-api/scripts/deliver-pull-request-event.mjs \
//     --repository <owner/name> --number <n> --installation <id> [--action opened] \
//     [--pull-request-json <file>] [--api-url http://127.0.0.1:3100] [--env <apps/cloud-api/.env>]
//
// The installation must be one a workspace connected (Settings, Connections), or the API drops
// the event (422). `--pull-request-json` reads the pull request from a file instead of asking gh:
// what `gh api repos/<owner>/<name>/pulls/<n>` prints, or a whole `pull_request` payload as
// GitHub sent it (the App's Advanced page shows one per delivery), whose `installation.id`
// stands unless `--installation` names another. It reads the env file as the API does (a
// variable the shell sets wins) for GITHUB_WEBHOOK_SECRET and PORT, and never prints the secret.
// AGENTS.md, "Agent runs", says what the API does with the event.

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// The route the API receives GitHub's webhooks on (`GITHUB_WEBHOOK_PATH`).
const WEBHOOK_PATH = '/api/github/webhooks';

function fail(message) {
  console.error(`deliver-pull-request-event: ${message}`);
  process.exit(1);
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      repository: { type: 'string' },
      number: { type: 'string' },
      action: { type: 'string' },
      installation: { type: 'string' },
      'pull-request-json': { type: 'string' },
      'api-url': { type: 'string' },
      env: { type: 'string', default: fileURLToPath(new URL('../.env', import.meta.url)) },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (existsSync(options.env)) process.loadEnvFile(options.env);

/** A whole number from 1, or null. */
const positive = (value) => {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The pull request, as GitHub's REST API has it (the webhook's `pull_request` is the same
// object), or a whole payload GitHub sent for one.
let read;
try {
  if (options['pull-request-json']) {
    read = JSON.parse(readFileSync(options['pull-request-json'], 'utf8'));
  } else {
    const repository = options.repository ?? fail('--repository <owner/name> is required.');
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
      fail('--repository is not owner/name.');
    }
    const number = positive(options.number ?? fail('--number <n> is required.'));
    if (number === null) fail('--number is not a pull request number.');
    read = JSON.parse(
      execFileSync('gh', ['api', `repos/${repository}/pulls/${number}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  }
} catch (error) {
  fail(
    `could not read the pull request: ${error instanceof Error ? error.message.split('\n')[0] : error}`,
  );
}
if (!isRecord(read)) fail('the pull request read is not a JSON object.');

const sent = isRecord(read.pull_request) ? read : null;
const pullRequest = sent ? sent.pull_request : read;
const repository = pullRequest.base?.repo?.full_name ?? options.repository;
if (typeof repository !== 'string') fail('the pull request names no repository (base.repo).');
const number = positive(pullRequest.number) ?? positive(options.number);
if (number === null) fail('the pull request has no number.');

const installationId =
  options.installation === undefined
    ? positive(sent?.installation?.id)
    : positive(options.installation);
if (installationId === null) {
  fail(
    options.installation === undefined
      ? '--installation <id> is required: the installation of the GitHub App a workspace connected, on GitHub.'
      : '--installation is not a whole number from 1.',
  );
}

// The body GitHub POSTs for a `pull_request` event.
const action = options.action ?? sent?.action ?? 'opened';
const installation = isRecord(sent?.installation)
  ? { ...sent.installation, id: installationId }
  : { id: installationId };
const payload = {
  ...sent,
  action,
  number,
  pull_request: pullRequest,
  repository: sent?.repository ?? pullRequest.base?.repo ?? { full_name: repository },
  sender: sent?.sender ?? pullRequest.user,
  installation,
};

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
if (secret === '') {
  fail(
    `GITHUB_WEBHOOK_SECRET is not set (${options.env}): it is what the API checks a delivery's signature with.`,
  );
}

// Signed as GitHub signs one: the HMAC-SHA256 of the body's very bytes, in hex.
const body = Buffer.from(JSON.stringify(payload), 'utf8');
const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const deliveryId = randomUUID();

const apiUrl = (options['api-url'] ?? `http://127.0.0.1:${process.env.PORT || 3100}`).replace(
  /\/+$/,
  '',
);
let target;
try {
  target = new URL(`${apiUrl}${WEBHOOK_PATH}`);
} catch {
  fail('--api-url is not an address.');
}
if (target.protocol !== 'http:' && target.protocol !== 'https:') {
  fail('--api-url is not an http or https address.');
}

console.log(
  `Delivering ${repository}#${number} (${action}) through installation ${installationId}, as delivery ${deliveryId}, to ${target}`,
);
let response;
try {
  response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'consola-deliver-pull-request-event',
      'x-github-event': 'pull_request',
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': signature,
    },
    body,
  });
} catch (error) {
  fail(`the API did not answer: ${error instanceof Error ? error.message : error}`);
}
console.log(`The API answered ${response.status}: ${await response.text()}`);
process.exit(response.ok ? 0 : 1);
