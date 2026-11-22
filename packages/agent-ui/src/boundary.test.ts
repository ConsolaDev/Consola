// @effect-diagnostics nodeBuiltinImport:off - The checker reads the source tree from disk.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Keeps the licence boundary. `@consola/agent-ui` is MIT, and `@consola/host` and the apps are
 * AGPL, so the package's own code (everything under `src/` but the copied `src/t3/`, the tests
 * and `src/testing/`) imports neither: not `@consola/host` (a devDependency, for the tests'
 * replay host only) and no path into `apps/`. The copied code is t3's MIT code and imports
 * neither either; it is checked too.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(SRC, '..');
const REPOSITORY = resolve(PACKAGE, '../..');
const APPS = join(REPOSITORY, 'apps');
const HOST = join(REPOSITORY, 'packages', 'host');
const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}${sep}`);

const isTestOnly = (file: string) =>
  /\.test\.tsx?$/.test(file) || relative(SRC, file).split(sep)[0] === 'testing';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });

const importsOf = (file: string): string[] =>
  ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles.map((i) => i.fileName);

/** Why `specifier`, imported from `file`, crosses the boundary, or `null`. */
export const crossing = (file: string, specifier: string): string | null => {
  if (specifier === '@consola/host' || specifier.startsWith('@consola/host/')) {
    return 'imports @consola/host (AGPL)';
  }
  if (/^apps\//.test(specifier)) return 'imports a path under apps/ (AGPL)';
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(file), specifier);
    if (under(target, APPS)) return 'imports a path under apps/ (AGPL)';
    if (under(target, HOST)) return 'imports @consola/host (AGPL)';
  }
  return null;
};

describe('the licence boundary', () => {
  const files = sourceFiles(SRC).filter((file) => !isTestOnly(file));

  it('finds the package code it checks', () => {
    expect(files.map((file) => relative(SRC, file))).toEqual(
      expect.arrayContaining([
        'AgentChat.tsx',
        'index.ts',
        join('t3', 'components', 'ChatView.tsx'),
      ]),
    );
  });

  it('no package code imports @consola/host or apps/', () => {
    const crossings = files.flatMap((file) =>
      importsOf(file).flatMap((specifier) => {
        const why = crossing(file, specifier);
        return why === null ? [] : [`${relative(SRC, file)}: ${specifier}: ${why}`];
      }),
    );
    expect(crossings).toEqual([]);
  });

  it('refuses the imports it is there to refuse', () => {
    const own = join(SRC, 'AgentChat.tsx');
    expect(crossing(own, '@consola/host')).toBe('imports @consola/host (AGPL)');
    expect(crossing(own, '@consola/host/src/testing/replay.ts')).toBe(
      'imports @consola/host (AGPL)',
    );
    expect(crossing(own, '../../../apps/desktop/src/shared/constants.ts')).toBe(
      'imports a path under apps/ (AGPL)',
    );
    expect(crossing(own, '../../host/src/bin.ts')).toBe('imports @consola/host (AGPL)');
    expect(crossing(own, '~/components/ChatView')).toBeNull();
    expect(crossing(own, './index.ts')).toBeNull();
  });

  it('keeps @consola/host a devDependency only', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(Object.keys(manifest[field] ?? {})).not.toContain('@consola/host');
    }
    expect(manifest.devDependencies?.['@consola/host']).toBe('workspace:*');
  });
});
