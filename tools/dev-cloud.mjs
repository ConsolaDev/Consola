// Starts all of Consola Cloud on this machine, for local development, in one terminal:
//
//   pnpm dev:cloud:all                    everything below
//   pnpm dev:cloud:all --no-runner        leave the runner out
//   pnpm dev:cloud:all --no-tunnel        leave the tunnel out
//
//   api     apps/cloud-api on 127.0.0.1:3100, restarting on every edit (tsx watch)
//   web     apps/cloud-web on http://localhost:5175 (Vite)
//   runner  `consola-host runner` (packages/host), once the API answers: only when
//           packages/host/.env exists and apps/cloud-api/.env sets RUNNER_SECRET
//   tunnel  the Cloudflare tunnel that brings GitHub's and Slack's hooks to the API: only when
//           apps/cloud-api/.env sets CLOUDFLARE_TUNNEL_TOKEN and no cloudflared tunnel is
//           running already (one started by hand is left alone)
//
// It builds the workspace packages they load first (Turborepo's cache makes that quick after
// the first time). Each line is labelled with the process it came from. Ctrl+C stops everything
// it started; a second Ctrl+C kills what is left. Secrets are read from the .env files and never
// printed: the tunnel's token reaches cloudflared in its environment, never on its command line.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_ENV = 'apps/cloud-api/.env';
const HOST_ENV = 'packages/host/.env';

const flags = new Set(process.argv.slice(2));
const apiEnv = readEnv(API_ENV);
const port = apiEnv.PORT || '3100';

// ── Output ──────────────────────────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY;
const COLORS = { dev: 90, api: 36, web: 35, runner: 33, tunnel: 34 };

function log(name, line) {
  const label = `[${name}]`.padEnd(9);
  const painted = useColor ? `\u001b[${COLORS[name]}m${label}\u001b[0m` : label;
  process.stdout.write(`${painted}${line}\n`);
}

const say = (line) => log('dev', line);

// ── What runs ───────────────────────────────────────────────────────────────────────────────

function readEnv(path) {
  const file = `${ROOT}/${path}`;
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/** Why the runner stays out, or null when it starts. */
function runnerSkipped() {
  if (flags.has('--no-runner')) return 'left out (--no-runner)';
  if (!existsSync(`${ROOT}/${HOST_ENV}`)) return `skipped: no ${HOST_ENV} (copy its .env.example)`;
  if (!apiEnv.RUNNER_SECRET) return `skipped: ${API_ENV} sets no RUNNER_SECRET`;
  return null;
}

/** Why the tunnel stays out, or null when it starts. */
function tunnelSkipped() {
  if (flags.has('--no-tunnel')) return 'left out (--no-tunnel)';
  if (!apiEnv.CLOUDFLARE_TUNNEL_TOKEN) return `skipped: ${API_ENV} sets no CLOUDFLARE_TUNNEL_TOKEN`;
  if (spawnSync('cloudflared', ['--version']).error) {
    return 'skipped: cloudflared is not installed (brew install cloudflared)';
  }
  const running = spawnSync('pgrep', ['-f', 'cloudflared tunnel'], { encoding: 'utf8' });
  if (running.status === 0) {
    return `already running (pid ${running.stdout.trim().split('\n').join(', ')}), left alone`;
  }
  return null;
}

// ── Processes ───────────────────────────────────────────────────────────────────────────────

const children = new Map();
let stopping = false;
let exitCode = 0;

/**
 * Starts `command` in a process group of its own, so stopping it stops everything it started
 * (pnpm, then tsx, then node). When an `essential` one ends by itself, everything stops.
 */
function start(name, command, args, { env = {}, essential = false } = {}) {
  const childEnv = { ...process.env, ...env };
  // Piped output loses colour unless asked for.
  if (useColor) childEnv.FORCE_COLOR = '1';
  const child = spawn(command, args, {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => log(name, line));
  }
  child.on('error', (error) => log(name, `could not start: ${error.message}`));
  child.on('close', (code, signal) => {
    children.delete(name);
    if (stopping) {
      if (children.size === 0) process.exit(exitCode);
      return;
    }
    log(name, `exited (${signal ?? `code ${code}`})`);
    if (essential) stop(code || 1);
  });
}

function signalAll(signal) {
  for (const child of children.values()) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Its group is gone already.
    }
  }
}

function stop(code = 0) {
  if (stopping) {
    say('killing what is left');
    signalAll('SIGKILL');
    process.exit(code);
  }
  stopping = true;
  exitCode = code;
  if (children.size === 0) process.exit(code);
  say('stopping…');
  signalAll('SIGTERM');
  setTimeout(() => stop(code), 10_000).unref();
}

async function apiAnswers() {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let tries = 0; tries < 120 && !stopping; tries++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────

if (!existsSync(`${ROOT}/${API_ENV}`)) {
  say(`no ${API_ENV}: copy apps/cloud-api/.env.example and fill it in (apps/cloud-api/README.md)`);
  process.exit(1);
}

const runnerWhy = runnerSkipped();
const tunnelWhy = tunnelSkipped();

say('building the packages the apps load…');
const build = spawnSync(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@consola/cloud-api^...',
    '--filter=@consola/cloud-web^...',
    ...(runnerWhy ? [] : ['--filter=@consola/host^...']),
    '--output-logs=errors-only',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('exit', () => signalAll('SIGKILL'));

say(`web     http://localhost:5175`);
say(`api     http://127.0.0.1:${port}`);
say(`runner  ${runnerWhy ?? 'starts once the API answers'}`);
say(`tunnel  ${tunnelWhy ?? `starting (${apiEnv.CLOUDFLARE_TUNNEL_HOSTNAME || 'named tunnel'})`}`);

start('api', 'pnpm', ['--filter', '@consola/cloud-api', 'run', 'dev'], { essential: true });
start('web', 'pnpm', ['--filter', '@consola/cloud-web', 'run', 'dev'], { essential: true });

if (!tunnelWhy) {
  start('tunnel', 'cloudflared', ['tunnel', '--no-autoupdate', '--grace-period', '2s', 'run'], {
    env: { TUNNEL_TOKEN: apiEnv.CLOUDFLARE_TUNNEL_TOKEN },
  });
}

if (!runnerWhy) {
  if (await apiAnswers()) {
    start('runner', process.execPath, [
      `--env-file=${HOST_ENV}`,
      'packages/host/src/main.ts',
      'runner',
      '--cell-url',
      `ws://127.0.0.1:${port}/api/runner`,
      '--runner-id',
      'demo-runner',
    ]);
  } else if (!stopping) {
    say(`the API never answered on ${port}/api/health, so the runner was not started`);
  }
}
