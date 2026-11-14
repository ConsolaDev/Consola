import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the engine portable. It runs on desktop, headless and in the cloud, so
 * no file may reach Electron, desktop code or an unlisted library, and the core
 * (everything outside `src/node/`) may not touch the machine at all.
 */

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SRC = 'src';
const NODE_DIR = 'src/node';
const ENTRY = 'src/index.ts';

const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DEPENDENCIES = Object.keys(packageJson.dependencies ?? {});
const DEV_DEPENDENCIES = Object.keys(packageJson.devDependencies ?? {});

const BUILTINS = new Set(builtinModules);
const IO_MODULES = new Set(['fs', 'os', 'child_process', 'net', 'http', 'https', 'dgram', 'worker_threads']);

const isTestFile = (file: string): boolean => /\.test(-helpers)?\.ts$/.test(file);

/** Every module specifier a source file imports, however it spells the import. */
function importsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const specifiers: string[] = [];
  const patterns = [
    /^\s*import\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/gm, // import … from, import type … from
    /^\s*import\s*['"]([^'"]+)['"]/gm, // import 'x'
    /^\s*export\s+(?:type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/gm, // export … from
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** What is wrong with a file's imports; empty when it keeps to the boundary. `file` is relative to the package root. */
function boundaryProblems(file: string, specifiers: string[]): string[] {
  const test = isTestFile(file);
  const inNode = file.startsWith(`${NODE_DIR}/`);
  const allowed = test ? [...DEPENDENCIES, ...DEV_DEPENDENCIES] : DEPENDENCIES;
  const problems: string[] = [];

  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const target = path.posix.join(path.posix.dirname(file), specifier);
      if (target !== SRC && !target.startsWith(`${SRC}/`)) {
        problems.push(`${file}: '${specifier}' leaves the package's src/`);
        continue;
      }
      if (inNode || test || file === ENTRY) continue;
      if (target === NODE_DIR || target.startsWith(`${NODE_DIR}/`)) {
        problems.push(`${file}: core code may not import '${specifier}' from src/node/`);
      } else if (target === SRC || target === `${SRC}/index`) {
        problems.push(`${file}: '${specifier}' is the entry point, which reaches src/node/`);
      }
      continue;
    }

    const bare = specifier.replace(/^node:/, '');
    if (specifier.startsWith('node:') || BUILTINS.has(packageName(bare))) {
      if (!inNode && !test && IO_MODULES.has(packageName(bare))) {
        problems.push(`${file}: core code may not import the I/O module '${specifier}'`);
      }
      continue;
    }

    if (!allowed.includes(packageName(specifier))) {
      problems.push(`${file}: '${specifier}' is not a dependency of this package`);
    }
  }
  return problems;
}

// Sources are built, not written out, so this file's own text holds no import
// statement for the checker to find when it scans the package below.
const esm = (specifier: string) => `import x from '${specifier}';`;
const esmType = (specifier: string) => `import type { T } from '${specifier}';`;
const sideEffect = (specifier: string) => `import '${specifier}';`;
const reExport = (specifier: string) => `export * from '${specifier}';`;
const cjs = (specifier: string) => `const x = ${'require'}('${specifier}');`;
const dynamic = (specifier: string) => `const x = await ${'import'}('${specifier}');`;

describe('the checker', () => {
  it('finds every spelling of an import, and nothing in comments', () => {
    const source = [
      esm('a'),
      esmType('b'),
      sideEffect('c'),
      reExport('d'),
      cjs('e'),
      dynamic('f'),
      `// ${esm('commented')}`,
      `/* ${esm('blocked')} */`,
    ].join('\n');
    expect(importsOf(source)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'f']));
    expect(importsOf(source)).toHaveLength(6);
  });

  const cases: Array<{ name: string; file: string; source: string; problems: RegExp | null }> = [
    { name: 'electron', file: 'src/x.ts', source: esm('electron'), problems: /electron/ },
    {
      name: 'desktop code, even as a type',
      file: 'src/x.ts',
      source: esmType('../../../apps/desktop/src/shared/workspace'),
      problems: /leaves the package/,
    },
    { name: 'node-pty', file: 'src/x.ts', source: esm('node-pty'), problems: /node-pty/ },
    { name: '@xterm/headless', file: 'src/x.ts', source: sideEffect('@xterm/headless'), problems: /@xterm\/headless/ },
    { name: 'a library not in package.json', file: 'src/x.ts', source: esm('left-pad'), problems: /left-pad/ },
    { name: 'a subpath of a dependency', file: 'src/x.ts', source: esm('zod/v3'), problems: null },
    { name: 'a dependency', file: 'src/x.ts', source: esm('@consola/factory-spec'), problems: null },
    { name: 'fs in core', file: 'src/x.ts', source: esm('fs'), problems: /fs/ },
    { name: 'node:fs in core', file: 'src/x.ts', source: esm('node:fs'), problems: /node:fs/ },
    { name: 'fs/promises in core', file: 'src/x.ts', source: esm('fs/promises'), problems: /fs\/promises/ },
    { name: 'fs in src/node', file: 'src/node/x.ts', source: esm('fs'), problems: null },
    { name: 'fs in a test', file: 'src/x.test.ts', source: esm('fs'), problems: null },
    { name: 'a pure built-in in core', file: 'src/x.ts', source: esm('crypto'), problems: null },
    { name: 'a sibling in core', file: 'src/x.ts', source: esm('./y'), problems: null },
    { name: 'src/node from core', file: 'src/x.ts', source: esm('./node/y'), problems: /src\/node/ },
    { name: 'src/node index from core', file: 'src/x.ts', source: esm('./node'), problems: /src\/node/ },
    { name: 'src/node from a nested core file', file: 'src/a/x.ts', source: esm('../node/y'), problems: /src\/node/ },
    { name: 'src/node from src/node', file: 'src/node/x.ts', source: esm('./y'), problems: null },
    { name: 'src/node from a test', file: 'src/x.test.ts', source: esm('./node/y'), problems: null },
    { name: 'src/node from the entry point', file: 'src/index.ts', source: reExport('./node'), problems: null },
    { name: 'the entry point from core', file: 'src/x.ts', source: esm('.'), problems: /entry point/ },
    { name: 'the entry point by name from core', file: 'src/a/x.ts', source: esm('../index'), problems: /entry point/ },
    { name: 'the entry point from a test', file: 'src/x.test.ts', source: esm('./index'), problems: null },
    { name: 'vitest in a test', file: 'src/x.test.ts', source: esm('vitest'), problems: null },
    { name: 'vitest in a test helper', file: 'src/x.test-helpers.ts', source: esm('vitest'), problems: null },
    { name: 'vitest in core', file: 'src/x.ts', source: esm('vitest'), problems: /vitest/ },
  ];

  it.each(cases)('$name', ({ file, source, problems }) => {
    const found = boundaryProblems(file, importsOf(source));
    if (problems === null) {
      expect(found).toEqual([]);
    } else {
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(problems);
    }
  });
});

describe('the package', () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(path.join(PACKAGE_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return files(relative);
      return relative.endsWith('.ts') ? [relative] : [];
    });

  it('keeps every file inside the boundary', () => {
    const problems = files(SRC).flatMap((file) =>
      boundaryProblems(file, importsOf(fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8'))),
    );
    expect(problems).toEqual([]);
  });
});
