// Brings GitHub's webhooks and Slack's events to the API on this machine through a Cloudflare
// tunnel, and says what to set on the GitHub App and on each factory's Slack app. Run it beside
// `pnpm dev:cloud`:
//
//   pnpm --filter @consola/cloud-api webhooks:tunnel
//
// By default it starts a quick tunnel (no Cloudflare account), whose address is new each time it
// starts, so the App's webhook URL has to be set again after every start. With
// CLOUDFLARE_TUNNEL_NAME and CLOUDFLARE_TUNNEL_HOSTNAME set, it runs that named tunnel instead,
// whose address stays put. It reads apps/cloud-api/.env, as the API does, for PORT, to say
// whether GITHUB_WEBHOOK_SECRET and CONNECTION_SECRETS_KEY are set, and whether SLACK_PUBLIC_URL
// is the tunnel's address; it never prints a secret. README.md, "Receive GitHub's webhooks" and
// "Connect a factory to Slack", has the whole set-up.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// The route the App's webhook URL ends in (`GITHUB_WEBHOOK_PATH`, in
// src/company/adapters/http/gitHubContract.ts).
const WEBHOOK_PATH = '/api/github/webhooks';
// Slack's request URL for a factory, and its redirect after "Add to Slack" (`slackEventsPath` and
// `SLACK_OAUTH_CALLBACK_PATH`, in src/company/domain/slack.ts).
const SLACK_EVENTS_PATH = '/api/slack/events/<factory id>';
const SLACK_CALLBACK_PATH = '/api/slack/oauth/callback';
const port = process.env.PORT || '3100';
const origin = `http://127.0.0.1:${port}`;
const named = process.env.CLOUDFLARE_TUNNEL_NAME?.trim() ?? '';
const hostname = process.env.CLOUDFLARE_TUNNEL_HOSTNAME?.trim() ?? '';
const cloudflared = process.env.CLOUDFLARED ?? 'cloudflared';

if (named !== '' && hostname === '') {
  console.error(
    'CLOUDFLARE_TUNNEL_NAME is set, so CLOUDFLARE_TUNNEL_HOSTNAME must say the address it is routed from (webhooks.example.com).',
  );
  process.exit(1);
}

const secret = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const secretLine =
  secret.length >= 32
    ? '  Secret:      the value of GITHUB_WEBHOOK_SECRET in apps/cloud-api/.env (set, not shown)'
    : `  Secret:      ${secret === '' ? 'none yet' : 'the one set is under 32 characters'}. Make one with \`openssl rand -hex 32\`, put it in apps/cloud-api/.env as\n` +
      '               GITHUB_WEBHOOK_SECRET=<it>, restart `pnpm dev:cloud`, and paste the same value here';

/** What Slack needs of the tunnel at `address`: the API's settings, then each app's. */
function slackLines(address) {
  const slackUrl = process.env.SLACK_PUBLIC_URL?.trim().replace(/\/$/, '') ?? '';
  const keySet = (process.env.CONNECTION_SECRETS_KEY ?? '') !== '';
  return [
    `Slack's events and its redirect after "Add to Slack" reach ${origin} through ${address} too.`,
    slackUrl === address
      ? "  SLACK_PUBLIC_URL is this address: each factory's manifest names it."
      : `  Set SLACK_PUBLIC_URL=${address} in apps/cloud-api/.env and restart \`pnpm dev:cloud\`, so each factory's manifest names it.`,
    keySet
      ? '  CONNECTION_SECRETS_KEY is set (not shown).'
      : '  CONNECTION_SECRETS_KEY is not set, so Slack is off: make one with `pnpm --filter @consola/cloud-api secrets-key:generate`.',
    "On each factory's Slack app (api.slack.com/apps, your app), if it was made from an older address:",
    `  Event Subscriptions, Request URL: ${address}${SLACK_EVENTS_PATH}`,
    `  OAuth & Permissions, Redirect URL: ${address}${SLACK_CALLBACK_PATH}`,
  ];
}

/** Says, once, what to set on the GitHub App and the Slack apps for the tunnel at `address`. */
function announce(address) {
  console.log(
    [
      '',
      `GitHub's webhooks reach ${origin} through ${address}.`,
      'On the GitHub App (GitHub, Settings, Developer settings, GitHub Apps, your app, General, Webhook):',
      '  Active:      on',
      `  Webhook URL: ${address}${WEBHOOK_PATH}`,
      secretLine,
      'Then, under Permissions & events, subscribe to the events you want (Pull request, Push), and',
      'press Redeliver on any delivery under Advanced to send it again.',
      '',
      ...slackLines(address),
      '',
      'Ctrl+C stops the tunnel.',
      named === ''
        ? 'This is a quick tunnel: its address changes each time it starts, so set these URLs again then.'
        : '',
      '',
    ].join('\n'),
  );
}

const args =
  named === ''
    ? ['tunnel', '--no-autoupdate', '--url', origin]
    : ['tunnel', '--no-autoupdate', 'run', '--url', origin, named];

const tunnel = spawn(cloudflared, args, { stdio: ['ignore', 'inherit', 'pipe'] });

tunnel.on('error', (error) => {
  const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
  console.error(
    missing
      ? 'cloudflared is not installed. On macOS: `brew install cloudflared`; elsewhere, see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
      : `cloudflared could not start: ${error.message}`,
  );
  process.exit(1);
});

if (named !== '') announce(`https://${hostname}`);

// A quick tunnel says its address on stderr, among its own lines; pass them through, and say
// what to set once the address appears.
let announced = named !== '';
let pending = '';
tunnel.stderr.setEncoding('utf8');
tunnel.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  if (announced) return;
  pending += chunk;
  const address = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(pending)?.[0];
  if (address !== undefined) {
    announced = true;
    pending = '';
    announce(address);
  } else if (pending.length > 64 * 1024) {
    pending = pending.slice(-1024);
  }
});

tunnel.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => tunnel.kill(signal));
}
