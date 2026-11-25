// @effect-diagnostics nodeBuiltinImport:off - The server's command line, and its standard streams.
/**
 * `consola-host step-tools --folder <dir>`: the step tools' MCP server, which an agent step's CLI
 * starts in its sandbox (`adapters/stepToolsServer.ts`). `main.ts` loads this file alone for it,
 * never `bin.ts`, so starting the server loads none of t3's runtime. It serves until its stdin
 * ends, then exits 0; a bad command line is a message on stderr and exit 1. Stdout is MCP's.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serveStepTools } from './adapters/stepToolsServer.ts';

const USAGE = 'Usage: consola-host step-tools --folder <the step folder>';

const fail = (problem: string): never => {
  process.stderr.write(`consola-host: ${problem}\n\n${USAGE}\n`);
  process.exit(1);
};

/** Runs the server for `argv` (`step-tools` and its flags). */
export const stepToolsMain = async (argv: ReadonlyArray<string>): Promise<void> => {
  let folder: string | undefined;
  try {
    const parsed = parseArgs({
      args: [...argv.slice(1)],
      options: { folder: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    folder = parsed.values.folder;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (folder === undefined || folder === '') return fail('--folder is required.');
  const dir = resolve(folder);
  let isFolder = false;
  try {
    isFolder = statSync(dir).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) return fail(`--folder ${dir} is not a folder.`);
  await serveStepTools(dir, process.stdin, process.stdout);
  process.exit(0);
};
