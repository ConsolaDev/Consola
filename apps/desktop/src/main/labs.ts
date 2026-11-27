import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_LABS, NO_LABS, parseLabs } from '../shared/labs';
import type { Labs } from '../shared/labs';
import { isTest } from './test-mode';

/** Where a computer turns labs on: the same file for the installed app and `pnpm dev`. */
export function labsFile(home = os.homedir()): string {
  return path.join(home, '.consola', 'labs.json');
}

/**
 * The labs this launch runs with (see `shared/labs.ts`). A test run never
 * reads the person's file, so the suite does not depend on whose computer it
 * runs on: every lab is on, unless `CONSOLA_E2E_LABS` gives the file's JSON
 * to use instead.
 */
export function readLabs({
  test = isTest,
  env = process.env,
  file = labsFile(),
}: {
  test?: boolean;
  env?: NodeJS.ProcessEnv;
  file?: string;
} = {}): Labs {
  if (test) {
    const given = env.CONSOLA_E2E_LABS;
    return given === undefined ? ALL_LABS : parseLabs(given);
  }
  try {
    return parseLabs(fs.readFileSync(file, 'utf8'));
  } catch {
    return NO_LABS;
  }
}

let current: Labs | undefined;

/** The labs read at launch. Read once: editing the file takes effect on the next start. */
export function labs(): Labs {
  current ??= readLabs();
  return current;
}

/** Whether this computer shows Automations (see `labs`). */
export function automationsShown(): boolean {
  return labs().automations;
}
