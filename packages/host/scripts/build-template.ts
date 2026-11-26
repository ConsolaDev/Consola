// @effect-diagnostics nodeBuiltinImport:off - A build script: it stages the template's folder on disk.
/**
 * Builds the `consola-session` sandbox template on Consola's E2B account
 * (`sandbox-template/README.md`), after `scripts/bundle.ts`:
 *
 *   pnpm --filter @consola/host template:build
 *
 * It stages the template's folder in `dist/sandbox-template/` (a Dockerfile's folder is the
 * context its COPY reads): its Dockerfile, the session's start script and the steps' two scripts
 * (`consola-step-checkout`, `consola-step-start`), the two files `scripts/bundle.ts` writes, and
 * t3's patch to `@ff-labs/fff-node` from the repository's `patches/`, which the Dockerfile applies
 * as pnpm does. Then it builds it there with `@consola/sandbox/e2b`'s builder,
 * under the name the runner creates sandboxes from (`SESSION_TEMPLATE`). The key is
 * `E2B_API_KEY`, from the environment or else `packages/sandbox/.env`; it is never an argument,
 * and never printed.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildE2BTemplate } from '@consola/sandbox/e2b';
import { SESSION_TEMPLATE } from '../src/core/runnerDecisions.ts';

const PACKAGE = join(import.meta.dirname, '..');
const TEMPLATE = join(PACKAGE, 'sandbox-template');
const BUNDLE = join(PACKAGE, 'dist', 'consola-host.mjs');
const HISTORY_WORKER = join(PACKAGE, 'dist', 'claude-history-worker.mjs');
const FFF_NODE_PATCH = join(PACKAGE, '..', '..', 'patches', '@ff-labs__fff-node@0.11.0.patch');
const STAGE = join(PACKAGE, 'dist', 'sandbox-template');
const SANDBOX_ENV = join(PACKAGE, '..', 'sandbox', '.env');

const refuse = (problem: string): never => {
  process.stderr.write(`${problem}\n`);
  process.exit(2);
};

for (const file of [BUNDLE, HISTORY_WORKER]) {
  if (!existsSync(file)) {
    refuse(
      `${relative(PACKAGE, file)} is not there: run pnpm --filter @consola/host bundle first.`,
    );
  }
}
if ((process.env.E2B_API_KEY ?? '').trim() === '' && existsSync(SANDBOX_ENV)) {
  process.loadEnvFile(SANDBOX_ENV);
}
const apiKey = (process.env.E2B_API_KEY ?? '').trim();
if (apiKey === '') {
  refuse('E2B_API_KEY is not set: set it, or put it in packages/sandbox/.env (see .env.example).');
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const file of [
  'Dockerfile',
  'consola-session-start',
  'consola-step-checkout',
  'consola-step-start',
]) {
  copyFileSync(join(TEMPLATE, file), join(STAGE, file));
}
copyFileSync(BUNDLE, join(STAGE, 'consola-host.mjs'));
copyFileSync(HISTORY_WORKER, join(STAGE, 'claude-history-worker.mjs'));
copyFileSync(FFF_NODE_PATCH, join(STAGE, 'fff-node.patch'));

const built = await buildE2BTemplate({
  apiKey,
  name: SESSION_TEMPLATE,
  folder: STAGE,
  onLog: (line) => process.stdout.write(`${line}\n`),
});
process.stdout.write(
  `Built ${built.name}: template ${built.templateId}, build ${built.buildId}. Record the template id in sandbox-template/README.md.\n`,
);
