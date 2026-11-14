import * as fs from 'fs';
import { builtinModules } from 'module';
import * as path from 'path';
import * as ts from 'typescript';
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
const IO_MODULES = new Set([
  'fs',
  'os',
  'child_process',
  'net',
  'http',
  'http2',
  'https',
  'tls',
  'dns',
  'dgram',
  'cluster',
  'readline',
  'worker_threads',
]);

const isTestFile = (file: string): boolean => /\.test(-helpers)?\.ts$/.test(file);

/** Stand-ins `importsOf` returns for an import it cannot resolve to a name. */
const NON_LITERAL = '<non-literal specifier>';
const CREATE_REQUIRE = '<createRequire>';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;

/**
 * Every module specifier a source file imports, however it spells the import.
 * It reads the syntax tree, so comments and strings never count. An import
 * whose specifier is not a plain string, and any use of `createRequire`, come
 * back as markers, because the checker cannot tell what they load.
 */
function importsOf(source: string): string[] {
  const tree = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node && ts.isStringLiteralLike(node) ? node.text : NON_LITERAL;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isExternalModuleReference(node)) {
      specifiers.push(literal(node.expression)); // import x = require('y')
    } else if (ts.isImportTypeNode(node)) {
      specifiers.push(ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : NON_LITERAL);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isResolve =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve';
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire || isResolve) {
        specifiers.push(literal(node.arguments[0]));
      }
    } else if (ts.isIdentifier(node) && node.text === 'createRequire') {
      specifiers.push(CREATE_REQUIRE);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
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
    if (specifier === NON_LITERAL) {
      problems.push(`${file}: cannot check a non-literal import`);
      continue;
    }
    if (specifier === CREATE_REQUIRE) {
      problems.push(`${file}: createRequire loads modules this check cannot see`);
      continue;
    }
    if (specifier.startsWith('.')) {
      const target = path.posix
        .join(path.posix.dirname(file), specifier)
        .replace(SOURCE_EXTENSION, '');
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

const esm = (specifier: string) => `import x from '${specifier}';`;
const esmType = (specifier: string) => `import type { T } from '${specifier}';`;
const sideEffect = (specifier: string) => `import '${specifier}';`;
const reExport = (specifier: string) => `export * from '${specifier}';`;

/** Every way to spell an import of one module, each as a source for the checker. */
const SPELLINGS: Array<{ name: string; source: (specifier: string) => string }> = [
  { name: 'default import', source: esm },
  { name: 'type import', source: esmType },
  { name: 'side-effect import', source: sideEffect },
  { name: 'multi-line named import', source: (m) => `import {\n  a,\n  b,\n} from '${m}';` },
  { name: 'namespace import', source: (m) => `import * as x from "${m}";` },
  { name: 'star re-export', source: reExport },
  { name: 'named re-export', source: (m) => `export { a } from '${m}';` },
  { name: 'type re-export', source: (m) => `export type { A } from '${m}';` },
  { name: 'import-equals require', source: (m) => `import x = require('${m}');` },
  { name: 'require', source: (m) => `const x = require('${m}');` },
  { name: 'require.resolve', source: (m) => `const x = require.resolve('${m}');` },
  { name: 'dynamic import', source: (m) => `const x = await import('${m}');` },
  { name: 'backtick dynamic import', source: (m) => `const x = await import(\`${m}\`);` },
  { name: 'dynamic import with attributes', source: (m) => `const x = await import('${m}', { with: { type: 'json' } });` },
  { name: 'import type expression', source: (m) => `let x: typeof import('${m}');` },
  { name: 'import after another statement', source: (m) => `const a = 1; import x from '${m}';` },
];

describe('the checker', () => {
  it('finds every spelling of an import, and nothing in comments or strings', () => {
    const source = [
      esm('a'),
      '// ' + esm('commented'),
      '/* ' + esm('blocked') + ' */',
      "const glob = 'src/**/*.ts'; const other = '*/'; " + esm('after-glob'),
      "const text = \"import x from 'quoted'\";",
    ].join('\n');
    expect(importsOf(source)).toEqual(['a', 'after-glob']);
  });

  describe.each(SPELLINGS)('$name', ({ source }) => {
    it('is caught when it loads electron', () => {
      const found = boundaryProblems('src/x.ts', importsOf(source('electron')));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(/electron/);
    });

    it('is allowed when it loads a dependency', () => {
      expect(boundaryProblems('src/x.ts', importsOf(source('zod')))).toEqual([]);
    });
  });

  it.each([
    ['dynamic import', 'const x = await import(name);'],
    ['require', 'const x = require(name);'],
    ['require.resolve', 'const x = require.resolve(name);'],
    ['template with a substitution', 'const x = await import(`elec${name}`);'],
    ['import with no argument', 'const x = require();'],
  ])('cannot check a non-literal %s', (_name, source) => {
    const found = boundaryProblems('src/x.ts', importsOf(source));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/non-literal/);
  });

  it.each([
    ['in core', 'src/x.ts'],
    ['in src/node', 'src/node/x.ts'],
  ])('refuses createRequire %s', (_name, file) => {
    const source = "import { createRequire } from 'module'; const r = createRequire(import.meta.url); r('electron');";
    expect(boundaryProblems(file, importsOf(source)).join('\n')).toMatch(/createRequire/);
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
    { name: 'the entry point as ./index.js', file: 'src/x.ts', source: esm('./index.js'), problems: /entry point/ },
    { name: 'the entry point as ./index.ts', file: 'src/x.ts', source: esm('./index.ts'), problems: /entry point/ },
    { name: 'the entry point as ../index.js', file: 'src/a/x.ts', source: esm('../index.js'), problems: /entry point/ },
    { name: 'src/node with an extension', file: 'src/x.ts', source: esm('./node/y.js'), problems: /src\/node/ },
    { name: 'src/node/index.mjs from core', file: 'src/x.ts', source: esm('./node/index.mjs'), problems: /src\/node/ },
    { name: 'a sibling with an extension', file: 'src/x.ts', source: esm('./y.js'), problems: null },
    { name: 'src/node with an extension from the entry point', file: 'src/index.ts', source: reExport('./node/index.js'), problems: null },
    { name: 'http2 in core', file: 'src/x.ts', source: esm('http2'), problems: /http2/ },
    { name: 'node:tls in core', file: 'src/x.ts', source: esm('node:tls'), problems: /node:tls/ },
    { name: 'dns in core', file: 'src/x.ts', source: esm('dns'), problems: /dns/ },
    { name: 'node:dns/promises in core', file: 'src/x.ts', source: esm('node:dns/promises'), problems: /dns/ },
    { name: 'cluster in core', file: 'src/x.ts', source: esm('cluster'), problems: /cluster/ },
    { name: 'readline in core', file: 'src/x.ts', source: esm('readline'), problems: /readline/ },
    { name: 'node:readline in src/node', file: 'src/node/x.ts', source: esm('node:readline'), problems: null },
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
      return /\.(?:[cm]?[jt]s|tsx)$/.test(relative) ? [relative] : [];
    });

  it('keeps every file inside the boundary', () => {
    const problems = files(SRC).flatMap((file) =>
      boundaryProblems(file, importsOf(fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8'))),
    );
    expect(problems).toEqual([]);
  });
});
