import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the package free of I/O, since the cloud app's `company` part (from every layer) and the
 * host import it, their `domain` and `application` included. A source file imports only other source files in `src/`
 * (never a package, never a `node:` builtin, never test code), and refers to no global that
 * reaches the machine (`process`, `fetch`, `console`, the clock and the timers). `index.ts` is
 * the entry point and holds only `export … from`. Tests may reach the machine and import the
 * package's `devDependencies`, but no file, tests included, imports a workspace package or leaves
 * `src/`.
 */

const SRC = import.meta.dirname;
const ENTRY = 'index.ts';

/**
 * Globals that reach the machine or the network without an import: the process and its module
 * system, the network, storage, other threads, output, the clock and the timers, and the ways to
 * run code this check cannot read (`eval`, `Function`) or reach the global object by another
 * name. It is a list, not every free name: globals that do no I/O (`Number`, `Object`, `JSON`,
 * `TypeError`) stay allowed.
 */
const MACHINE_GLOBALS = [
  // The process, and the module system, which loads what an import would (`module.require`).
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Buffer',
  'Deno',
  'Bun',
  // The network, storage, cryptography, other threads, the outside world.
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'crypto',
  'console',
  // The clock and the timers: a reader is handed the time instead.
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'AbortSignal',
  'Date',
  'performance',
  // Code this check cannot read, and the global object by any name.
  'eval',
  'Function',
  'globalThis',
  'global',
  'window',
  'self',
];

/** What every file, tests included, may never import: a workspace package. */
const WORKSPACE_PACKAGES = '@consola/';

const packageJson = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DEV_DEPENDENCIES = Object.keys(packageJson.devDependencies ?? {});

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const isTestFile = (file: string): boolean => /\.test\.(?:[cm]?[jt]s|tsx)$/.test(file);

/** Stand-in for an import whose specifier is not a plain string, which nothing can check. */
const NON_LITERAL = '<non-literal specifier>';
/** Stand-in for `createRequire`, which loads modules this check cannot see. */
const CREATE_REQUIRE = '<createRequire>';

/**
 * Every module specifier a source file imports, however it spells it: `import`, `import type`,
 * `export … from`, `import x = require()`, `require()`, `require.resolve()`, dynamic `import()`
 * and `typeof import()`. It reads the syntax tree, so comments and strings never count.
 */
function importsOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const literal = (node: ts.Node | undefined): string =>
    node && ts.isStringLiteralLike(node) ? node.text : NON_LITERAL;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) specifiers.push(literal(node.moduleSpecifier));
    } else if (ts.isExternalModuleReference(node)) {
      specifiers.push(literal(node.expression));
    } else if (ts.isImportTypeNode(node)) {
      specifiers.push(
        ts.isLiteralTypeNode(node.argument) ? literal(node.argument.literal) : NON_LITERAL,
      );
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

/** Objects whose members are globals, so `globalThis.fetch` refers to `fetch`. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

const isGlobalObject = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);

/**
 * Every name a source file refers to, as a value or a type. A name is not a reference when it
 * is a property's or a member's own name (`request.process`, `{ fetch: 1 }`, a method, a type
 * member), when it is being declared (a variable, a parameter, a function, a class, an import),
 * or when it is `require` called as an import, which `importsOf` judges by what it loads. A
 * member of `globalThis` (or `global`, `window`, `self`) refers to the global it names. It does
 * not follow scopes, so a local that shares a global's name is reported where it is read.
 */
function referencesOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const isOwnName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
    if (ts.isQualifiedName(parent)) return parent.right === node;
    if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) {
      return parent.name === node || parent.propertyName === node;
    }
    if (ts.isExportSpecifier(parent)) {
      // `export { a } from './y'` names another module's export; `export { a as b }` declares `b`.
      const reexport = parent.parent.parent.moduleSpecifier !== undefined;
      return reexport || (parent.propertyName !== undefined && parent.name === node);
    }
    if (
      ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)
    ) {
      return parent.name === node;
    }
    return false;
  };

  const isRequireImport = (node: ts.Identifier): boolean => {
    if (node.text !== 'require') return false;
    const parent = node.parent;
    if (ts.isCallExpression(parent) && parent.expression === node) return true;
    return (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      parent.name.text === 'resolve'
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const globalMember =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        isGlobalObject(parent.expression);
      if (globalMember || (!isOwnName(node) && !isRequireImport(node))) found.push(node.text);
    } else if (
      ts.isStringLiteralLike(node) &&
      ts.isElementAccessExpression(node.parent) &&
      node.parent.argumentExpression === node &&
      isGlobalObject(node.parent.expression)
    ) {
      found.push(node.text); // globalThis['fetch']
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** What an entry point holds besides `export … from`, each as its first line. */
function entryStatementsOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return tree.statements
    .filter((statement) => !(ts.isExportDeclaration(statement) && statement.moduleSpecifier))
    .map((statement) => statement.getText(tree).split('\n')[0] ?? '');
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/**
 * Every way one file breaks the rule: `<file> imports <specifier>`, `<file> uses <global>`, or
 * `<file> holds <statement>` for the entry point. `file` is relative to `src/`; nothing is read
 * from disk, so a test can feed it any source.
 */
function violationsOf(file: string, source: string): string[] {
  const test = isTestFile(file);

  const broken = (specifier: string): boolean => {
    if (specifier === NON_LITERAL || specifier === CREATE_REQUIRE) return true;
    if (specifier.startsWith('.')) {
      const target = posix.join(posix.dirname(file), specifier).replace(SOURCE_EXTENSION, '');
      if (target === '..' || target.startsWith('../')) return true; // leaves src/
      return !test && isTestFile(`${target}.ts`); // test code would be compiled into dist
    }
    if (specifier.startsWith(WORKSPACE_PACKAGES)) return true;
    if (!test) return true; // the package itself imports no package and no builtin
    return !isBuiltin(specifier) && !DEV_DEPENDENCIES.includes(packageName(specifier));
  };

  const imports = importsOf(source, file)
    .filter(broken)
    .map((specifier) => `${file} imports ${specifier}`);
  const globals = test
    ? []
    : [...new Set(referencesOf(source, file).filter((name) => MACHINE_GLOBALS.includes(name)))];
  const statements =
    file === ENTRY
      ? entryStatementsOf(source, file).map((statement) => `${file} holds ${statement}`)
      : [];
  return [...imports, ...globals.map((name) => `${file} uses ${name}`), ...statements];
}

/** Every source file under `src/`, relative to it. */
function sourceFiles(dir = ''): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return SOURCE_EXTENSION.test(entry.name) && !entry.name.endsWith('.d.ts') ? [relative] : [];
  });
}

describe('the package does no I/O', () => {
  it('every source file keeps the rule', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsOf(file, readFileSync(join(SRC, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('the checker sees the source tree', () => {
    const files = sourceFiles().filter((file) => !isTestFile(file));
    expect(files).toContain(ENTRY);
    expect(files.length).toBeGreaterThan(4);
  });

  it('the package has no dependencies, only development ones', () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  it.each([
    ['import type', "import type { JWTPayload } from 'jose';"],
    ['export … from', "export { SignJWT } from 'jose';"],
    ['export * from', "export * from 'jose';"],
    ['a side-effect import', "import 'jose';"],
    ['dynamic import()', "const loaded = await import('jose');"],
    ['typeof import()', "let loaded: typeof import('jose');"],
    ['require()', "const loaded = require('jose');"],
    ['require.resolve()', "const where = require.resolve('jose');"],
    ['import = require()', "import loaded = require('jose');"],
  ])('the checker reads %s', (_spelling, source) => {
    expect(violationsOf('messages.ts', source)).toEqual(['messages.ts imports jose']);
  });

  it('the checker ignores imports in comments and strings', () => {
    const source = "// import x from 'jose';\nconst a = \"import x from 'jose'\";";
    expect(violationsOf('messages.ts', source)).toEqual([]);
  });

  it.each([
    ['messages.ts', './region.js', true],
    ['messages.ts', './sub/thing.js', true],
    ['messages.ts', 'zod', false],
    ['messages.ts', 'jose', false],
    ['messages.ts', 'node:crypto', false],
    ['messages.ts', 'crypto', false],
    ['messages.ts', 'vitest', false],
    ['messages.ts', '@consola/factory-spec', false],
    ['messages.ts', './cellToken.test.js', false],
    ['messages.ts', '../package.json', false],
    ['messages.ts', '../../../apps/cloud-api/src/shared/region.js', false],
    ['messages.test.ts', 'vitest', true],
    ['messages.test.ts', 'node:fs', true],
    ['messages.test.ts', 'typescript', true],
    ['messages.test.ts', './cellToken.js', true],
    ['messages.test.ts', 'jose', false],
    ['messages.test.ts', '@consola/sandbox', false],
    ['messages.test.ts', '../../../apps/cloud-api/src/compose.js', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it('the checker refuses every global that reaches the machine', () => {
    for (const name of MACHINE_GLOBALS) {
      expect(violationsOf('outbox.ts', `const reached = ${name};`)).toEqual([
        `outbox.ts uses ${name}`,
      ]);
    }
  });

  it.each([
    ['Date', 'const now = Math.floor(Date.now() / 1000);'],
    ['crypto', 'const id = crypto.randomUUID();'],
    ['console', "console.log('reached');"],
    ['process', 'let here: typeof process;'],
    ['process', 'const reached = { process };'],
    ['module', "module.require('node:fs');"],
    ['eval', "(0, eval)('this');"],
    ['Function', "new Function('return this')();"],
  ])('the checker reports %s: %s', (name, source) => {
    expect(violationsOf('outbox.ts', source)).toEqual([`outbox.ts uses ${name}`]);
  });

  it('the checker reads a global reached through globalThis as that global', () => {
    expect(violationsOf('outbox.ts', "void globalThis['fetch']('/');")).toEqual([
      'outbox.ts uses globalThis',
      'outbox.ts uses fetch',
    ]);
  });

  it.each([
    ['a property read', 'const a = request.process;'],
    ['a method call', 'const a = client.fetch(1);'],
    ['an object key', 'const a = { process: 1, Date: 2 };'],
    ['a type member', 'type A = { crypto: string; fetch(): void };'],
    ['a destructured property', 'function a({ console }: { console: number }) {}'],
    ['a string or a comment', "// Date.now()\nconst a = 'fetch(require)';"],
    ['a global that does no I/O', 'const a = Number.isSafeInteger(JSON.parse(b).n);'],
  ])('the checker does not report %s', (_name, source) => {
    expect(violationsOf('outbox.ts', source)).toEqual([]);
  });

  it('the checker lets tests reach the machine', () => {
    expect(violationsOf('outbox.test.ts', 'const now = Date.now();')).toEqual([]);
  });

  it.each([
    ['code', "export * from './region.js';\nconst x = 1;"],
    ['a local export', 'export const x = 1;'],
    ['a plain import', "import { REGIONS } from './region.js';"],
    ['a default export', 'export default {};'],
  ])('the checker refuses an entry point holding %s', (_name, source) => {
    expect(violationsOf(ENTRY, source).length).toBeGreaterThan(0);
  });

  it('the checker allows an entry point of exports and comments', () => {
    const source =
      "/** doc */\nexport * from './region.js';\nexport { a, type B } from './outbox.js';";
    expect(violationsOf(ENTRY, source)).toEqual([]);
  });

  it('the checker refuses an import it cannot read', () => {
    expect(violationsOf('outbox.ts', 'const loaded = await import(name);')).toEqual([
      `outbox.ts imports ${NON_LITERAL}`,
    ]);
    expect(violationsOf('outbox.ts', "const load = createRequire('/');\nload('jose');")).toContain(
      `outbox.ts imports ${CREATE_REQUIRE}`,
    );
  });
});
