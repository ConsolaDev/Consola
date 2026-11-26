// Builds one of packages/sandbox/templates on Consola's E2B account, under its folder's name:
//
//   pnpm --filter @consola/sandbox template:build consola-base
//
// The key comes from packages/sandbox/.env (E2B_API_KEY) or the environment, never from an
// argument, and is never printed. The package's `template:build` script compiles it first.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildE2BTemplate } from '../dist/e2b.js';

const root = join(import.meta.dirname, '..');
const envFile = join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const templates = readdirSync(join(root, 'templates'));
const name = process.argv[2];
if (!name || !templates.includes(name)) {
  console.error(`Name the template to build: ${templates.join(', ')}.`);
  process.exit(2);
}
const apiKey = process.env.E2B_API_KEY?.trim() ?? '';
if (apiKey === '') {
  console.error('E2B_API_KEY is not set: put it in packages/sandbox/.env (see .env.example).');
  process.exit(2);
}

const built = await buildE2BTemplate({
  apiKey,
  name,
  folder: join(root, 'templates', name),
  onLog: (line) => console.log(line),
});
console.log(`Built ${built.name}: template ${built.templateId}, build ${built.buildId}.`);
