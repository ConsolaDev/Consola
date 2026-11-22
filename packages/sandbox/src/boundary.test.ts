import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the dependency rule, and keeps the core free of I/O. `domain` holds the values, errors
 * and rules; `application` the port providers implement and `sandboxesFrom`, which every caller
 * goes through; `contract` the checks every provider passes; `providers/fake` the in-memory
 * provider; `index.ts` the entry point, which only re-exports. All of that is the core: it
 * imports no package and no `node:` builtin, and refers to no global that reaches the machine
 * (`process`, `fetch`, the timers). A real provider gets a layer of its own under `providers/`,
 * the one place allowed to import its SDK and reach the network, with an entry point of its own
 * (`AGENTS.md`). Test files are exempt from the layer rules.
 */

const SRC = __dirname;

/** Every package and every `node:` builtin. */
const ANY_PACKAGE = '*';
/** Every `node:` builtin, however it is spelled. */
const NODE_BUILTINS = 'node:*';

type Layer = {
  /** A folder under `src/`, or a file there without its extension. */
  at: string;
  /** The layers its relative imports may reach. */
  reaches: string[];
  /** Packages it may not import: a name, a scope (`@scope/*`), `node:*` or `*`. */
  refuses: string[];
  /** Globals it may not refer to. */
  noGlobals: string[];
  /** An entry point: it holds only `export … from` statements. */
  entry?: boolean;
};

/**
 * Globals that reach the machine or the network without an import: the process and its module
 * system, the network, storage, other threads, output, the clock and the timers, and the ways to
 * run code this check cannot read (`eval`, `Function`) or reach the global object by another
 * name. It is a list, not every free name: globals that do no I/O (`URL`, `TextEncoder`,
 * `Promise`) stay allowed.
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
  // The network, storage, other threads, the outside world.
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
  'console',
  // The clock and the timers (`AbortSignal.timeout` among them).
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

/** A layer of the core: no package, no builtin, no global that reaches the machine. */
const core = (at: string, reaches: string[], entry = false): Layer => ({
  at,
  reaches,
  refuses: [ANY_PACKAGE],
  noGlobals: MACHINE_GLOBALS,
  entry,
});

const LAYERS: Layer[] = [
  core('domain', ['domain']),
  core('application', ['domain', 'application']),
  core('contract', ['domain', 'application', 'contract']),
  core('providers/fake', ['domain', 'application', 'providers/fake']),
  core('index', ['domain', 'application', 'contract', 'providers/fake'], true),
  // A real provider adds two layers here: its folder, which reaches `domain`, `application`
  // and itself, refuses nothing and may reach the machine; and its entry point, `src/<name>.ts`,
  // which reaches only that folder.
];

/** What every file, tests included, may never import: another workspace package. */
const NEVER = ['@consola/*'];

const packageJson = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DEPENDENCIES = Object.keys(packageJson.dependencies ?? {});
const DEV_DEPENDENCIES = Object.keys(packageJson.devDependencies ?? {});

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const isTestFile = (file: string): boolean => /\.test(?:-helpers)?\.(?:[cm]?[jt]s|tsx)$/.test(file);

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

function matches(pattern: string, specifier: string): boolean {
  if (pattern === ANY_PACKAGE) return true;
  if (pattern === NODE_BUILTINS) return isBuiltin(specifier);
  if (pattern.endsWith('/*')) return packageName(specifier).startsWith(pattern.slice(0, -1));
  return packageName(specifier) === pattern;
}

/** The layer a path under `src/` (no extension) belongs to, or null when it is in none. */
function layerOf(path: string): Layer | null {
  return LAYERS.find((layer) => path === layer.at || path.startsWith(`${layer.at}/`)) ?? null;
}

/**
 * Every way one file breaks the rule: `<file> imports <specifier>`, `<file> uses <global>`,
 * `<file> holds <statement>` for an entry point, or `<file> is in no layer`. `file` is relative
 * to `src/`; nothing is read from disk, so a test can feed it any source.
 */
function violationsOf(file: string, source: string): string[] {
  const test = isTestFile(file);
  const own = layerOf(file.replace(SOURCE_EXTENSION, ''));
  if (!test && !own) return [`${file} is in no layer`];

  const broken = (specifier: string): boolean => {
    if (specifier === NON_LITERAL || specifier === CREATE_REQUIRE) return true;
    if (specifier.startsWith('.')) {
      const target = posix.join(posix.dirname(file), specifier).replace(SOURCE_EXTENSION, '');
      if (target === '..' || target.startsWith('../')) return true; // leaves src/
      if (test) return false;
      if (isTestFile(`${target}.ts`)) return true; // test code would be compiled into dist
      const reached = layerOf(target);
      return !reached || !own?.reaches.includes(reached.at);
    }
    if (NEVER.some((pattern) => matches(pattern, specifier))) return true;
    if (!isBuiltin(specifier)) {
      const allowed = test ? [...DEPENDENCIES, ...DEV_DEPENDENCIES] : DEPENDENCIES;
      if (!allowed.includes(packageName(specifier))) return true; // not in package.json
    }
    if (test) return false;
    return own?.refuses.some((pattern) => matches(pattern, specifier)) ?? false;
  };

  const imports = importsOf(source, file)
    .filter(broken)
    .map((specifier) => `${file} imports ${specifier}`);
  const globals =
    test || !own
      ? []
      : [...new Set(referencesOf(source, file).filter((name) => own.noGlobals.includes(name)))];
  const statements =
    !test && own?.entry
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

describe('the dependency rule', () => {
  it('every source file keeps the dependency rule', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsOf(file, readFileSync(join(SRC, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('the checker sees the source tree', () => {
    expect(sourceFiles().filter((file) => !isTestFile(file)).length).toBeGreaterThan(8);
  });

  it.each([
    ['import type', "import type { Sandbox } from 'e2b';"],
    ['export … from', "export { Sandbox } from 'e2b';"],
    ['export * from', "export * from 'e2b';"],
    ['a side-effect import', "import 'e2b';"],
    ['dynamic import()', "const loaded = await import('e2b');"],
    ['typeof import()', "let loaded: typeof import('e2b');"],
    ['require()', "const loaded = require('e2b');"],
    ['require.resolve()', "const where = require.resolve('e2b');"],
    ['import = require()', "import loaded = require('e2b');"],
  ])('the checker reads %s', (_spelling, source) => {
    expect(violationsOf('application/x.ts', source)).toEqual(['application/x.ts imports e2b']);
  });

  it('the checker ignores imports in comments and strings', () => {
    const source = "// import x from 'e2b';\nconst a = \"import x from 'e2b'\";";
    expect(violationsOf('domain/x.ts', source)).toEqual([]);
  });

  // One case for each rule in LAYERS and NEVER, spelled as a plain import.
  it.each([
    ['domain/x.ts', './errors.js', true],
    ['domain/x.ts', '../application/ports.js', false],
    ['domain/x.ts', 'node:crypto', false],
    ['domain/x.ts', 'crypto', false],
    ['application/x.ts', '../domain/errors.js', true],
    ['application/x.ts', './ports.js', true],
    ['application/x.ts', '../contract/expect.js', false],
    ['application/x.ts', '../providers/fake/FakeProvider.js', false],
    ['application/x.ts', 'vitest', false],
    ['contract/x.ts', '../application/sandboxes.js', true],
    ['contract/x.ts', '../domain/errors.js', true],
    ['contract/x.ts', '../providers/fake/FakeProvider.js', false],
    ['contract/x.ts', 'vitest', false],
    ['providers/fake/x.ts', '../../application/ports.js', true],
    ['providers/fake/x.ts', './paths.js', true],
    ['providers/fake/x.ts', '../../contract/expect.js', false],
    ['providers/fake/x.ts', 'node:fs', false],
    ['providers/fake/x.ts', 'node:timers', false],
    ['providers/fake/x.ts', '../e2b/provider.js', false],
    ['domain/x.ts', '@consola/factory-spec', false],
    ['domain/x.ts', '../../../apps/desktop/src/x.js', false],
    ['domain/x.ts', './y.test.js', false],
    ['domain/x.ts', './y.test-helpers.js', false],
    ['domain/x.test.ts', '../providers/fake/FakeProvider.js', true],
    ['domain/x.test.ts', 'vitest', true],
    ['domain/x.test.ts', 'node:fs', true],
    ['x.test.ts', '@consola/factory-spec', false],
    ['x.test.ts', '../../../apps/desktop/src/x.js', false],
    ['x.test.ts', 'left-pad', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  // The entry point only re-exports, so its cases are spelled as `export * from`.
  it.each([
    ['./providers/fake/FakeProvider.js', true],
    ['./contract/sandboxContract.js', true],
    ['./domain/errors.js', true],
    ['./providers/e2b/provider.js', false],
    ['e2b', false],
  ])('index.ts re-exporting %s is allowed: %s', (specifier, allowed) => {
    expect(violationsOf('index.ts', `export * from '${specifier}';`)).toEqual(
      allowed ? [] : [`index.ts imports ${specifier}`],
    );
  });

  it.each(['domain', 'application', 'contract', 'providers/fake'])(
    'the checker refuses every global that reaches the machine in %s',
    (layer) => {
      for (const name of MACHINE_GLOBALS) {
        expect(violationsOf(`${layer}/x.ts`, `const reached = ${name};`)).toEqual([
          `${layer}/x.ts uses ${name}`,
        ]);
      }
    },
  );

  it.each([
    ['process', 'const home = process.env.HOME;'],
    ['fetch', "void fetch('/');"],
    ['setTimeout', 'setTimeout(() => {}, 1);'],
    ['WebSocket', "const socket = new WebSocket('ws://sprocket.test');"],
    ['process', 'let here: typeof process;'],
    ['process', 'const reached = { process };'],
    ['module', "module.require('node:fs');"],
    ['eval', "(0, eval)('this');"],
    ['Function', "new Function('return this')();"],
    ['console', "console.log('reached');"],
    ['Date', 'const now = Date.now();'],
    ['AbortSignal', 'const timer = AbortSignal.timeout(10);'],
  ])('the checker reports %s in the core: %s', (name, source) => {
    expect(violationsOf('providers/fake/x.ts', source)).toEqual([
      `providers/fake/x.ts uses ${name}`,
    ]);
  });

  it('the checker reads a global reached through globalThis as that global', () => {
    expect(violationsOf('domain/x.ts', "void globalThis.fetch('/');")).toEqual([
      'domain/x.ts uses globalThis',
      'domain/x.ts uses fetch',
    ]);
  });

  it.each([
    ['a property read', 'const a = request.process;'],
    ['a method call', 'const a = client.fetch(1);'],
    ['an object key', 'const a = { process: 1, fetch: 2 };'],
    ['a method', 'class A { fetch() {} }'],
    ['a type member', 'type A = { process: string; fetch(): void };'],
    ['a destructured property', 'function a({ fetch }: { fetch: number }) {}'],
    ['a string or a comment', "// process.env\nconst a = 'fetch(require)';"],
    ['a global that does no I/O', 'const a = new URL(new TextDecoder().decode(b));'],
  ])('the checker does not report %s', (_name, source) => {
    expect(violationsOf('domain/x.ts', source)).toEqual([]);
  });

  it('the checker lets tests reach the machine', () => {
    expect(violationsOf('domain/x.test.ts', "process.env.X = '1';")).toEqual([]);
  });

  it.each([
    ['code', "export * from './domain/errors';\nconst x = 1;"],
    ['a local export', 'export const x = 1;'],
    ['a plain import', "import { a } from './domain/errors';"],
    ['a default export', 'export default {};'],
  ])('the checker refuses an entry point holding %s', (_name, source) => {
    expect(violationsOf('index.ts', source).length).toBeGreaterThan(0);
  });

  it('the checker allows an entry point of exports and comments', () => {
    const source =
      "/** doc */\nexport * from './domain/errors';\nexport { a, type B } from './application/sandboxes';";
    expect(violationsOf('index.ts', source)).toEqual([]);
  });

  it('the checker refuses a file in no layer, and an import it cannot read', () => {
    expect(violationsOf('providers/e2b/x.ts', '')).toEqual(['providers/e2b/x.ts is in no layer']);
    expect(violationsOf('domain/x.ts', 'const loaded = await import(name);')).toEqual([
      `domain/x.ts imports ${NON_LITERAL}`,
    ]);
    expect(violationsOf('domain/x.ts', "const load = createRequire('/');\nload('e2b');")).toContain(
      `domain/x.ts imports ${CREATE_REQUIRE}`,
    );
  });
});
