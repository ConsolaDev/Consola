import * as fs from 'node:fs';
import { afterAll } from 'vitest';
import { isolateTestProcess } from './realCliIsolation';

/*
 * vitest's `setupFiles` for every desktop unit test: before a test file is
 * imported, its process gets a home of its own and loses every way to the
 * person's agent CLIs (`realCliIsolation.ts`), or, where one sits in a system
 * folder or on the login shell's PATH, the file does not run at all. The pool
 * is `forks`, so this changes the process's own environment: `os.homedir()`
 * and every child a test spawns see it. `realCliIsolation.test.ts` proves it
 * through the drivers and the login environment they read.
 */

const home = isolateTestProcess(process.env);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
