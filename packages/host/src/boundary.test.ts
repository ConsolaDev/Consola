// @effect-diagnostics nodeBuiltinImport:off - The checker reads the source tree from disk.
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Keeps the dependency rule: imports point inward only. `core` holds the pure decisions and the
 * types they speak of, `runtime` the Effect services over the vendored t3 packages, `adapters`
 * what touches the outside (WebSocket, pass verification, process I/O), and `bin.ts` is the one
 * place they are wired together. `core` also reaches no global that touches the machine
 * (`process`, `fetch`, `WebSocket`, timers). Test files are exempt from the layer rules, since
 * they wire real pieces together the way the ring does.
 *
 * To add a ring, add a row to `LAYERS` and a case to the table of allowed imports below.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

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
};

/** Globals that reach the machine or the network without an import, timers included. */
const MACHINE_GLOBALS = [
  'process',
  'fetch',
  'require',
  'XMLHttpRequest',
  'WebSocket',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'globalThis',
  'global',
];

const LAYERS: Layer[] = [
  {
    // Pure decisions. The vendored contracts are types and schemas, so they may be named
    // (`ModelSelection`); nothing that reaches the machine or the network.
    at: 'core',
    reaches: ['core'],
    refuses: [NODE_BUILTINS, 'effect/process', 'ws', 'jose'],
    noGlobals: MACHINE_GLOBALS,
  },
  {
    // Effect services over the vendored packages. Free to use them and `core`, never the
    // adapters that sit outside it.
    at: 'runtime',
    reaches: ['core', 'runtime'],
    refuses: [],
    noGlobals: [],
  },
  {
    at: 'adapters',
    reaches: ['core', 'runtime', 'adapters'],
    refuses: [],
    noGlobals: [],
  },
  // The one wiring file, where everything meets.
  {
    at: 'bin',
    reaches: ['core', 'runtime', 'adapters'],
    refuses: [],
    noGlobals: [],
  },
];

/** What every file, tests included, may never import: another Consola package or an app. */
const NEVER = ['@consola/*'];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const isTestFile = (file: string): boolean => /\.test\.(?:[cm]?[jt]s|tsx)$/.test(file);

/** Stand-in for an import whose specifier is not a plain string, which nothing can check. */
const NON_LITERAL = '<non-literal specifier>';

/**
 * Every module specifier a source file imports, however it spells it: `import`, `import type`,
 * `export … from`, `import x = require()`, `require()`, dynamic `import()` and `typeof
 * import()`. It reads the syntax tree, so comments and strings never count.
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
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire) {
        specifiers.push(literal(node.arguments[0]));
      }
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
 * Every name a source file refers to, as a value or a type. A name is not a reference when it is
 * a property's or a member's own name (`request.process`, `{ fetch: 1 }`), when it is being
 * declared (a variable, a parameter, a function, a class, an import), or when it is `require`
 * called as an import, which `importsOf` judges by what it loads. A member of `globalThis` (or
 * `global`, `window`, `self`) refers to the global it names. It does not follow scopes, so a
 * local that shares a global's name is reported where it is read.
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

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function matches(pattern: string, specifier: string): boolean {
  if (pattern === ANY_PACKAGE) return true;
  if (pattern === NODE_BUILTINS) return isBuiltin(specifier);
  // A subpath pattern (`effect/process`) names that entry point and anything below it.
  if (pattern.includes('/') && !pattern.endsWith('/*') && !pattern.startsWith('@')) {
    return specifier === pattern || specifier.startsWith(`${pattern}/`);
  }
  if (pattern.endsWith('/*')) return packageName(specifier).startsWith(pattern.slice(0, -1));
  return packageName(specifier) === pattern;
}

/** The layer a path under `src/` (no extension) belongs to, or null when it is in none. */
function layerOf(path: string): Layer | null {
  return LAYERS.find((layer) => path === layer.at || path.startsWith(`${layer.at}/`)) ?? null;
}

/**
 * Every way one file breaks the rule, as `<file> imports <specifier>`, `<file> uses <global>`
 * (or `<file> is in no layer`). `file` is relative to `src/`; nothing is read from disk, so a
 * test can feed it any source.
 */
function violationsOf(file: string, source: string): string[] {
  const test = isTestFile(file);
  const own = layerOf(file.replace(SOURCE_EXTENSION, ''));
  if (!test && !own) return [`${file} is in no layer`];

  const broken = (specifier: string): boolean => {
    if (specifier === NON_LITERAL) return true;
    if (specifier.startsWith('.')) {
      const target = posix.join(posix.dirname(file), specifier).replace(SOURCE_EXTENSION, '');
      if (target === '..' || target.startsWith('../')) return true; // leaves src/
      if (test) return false;
      if (isTestFile(`${target}.ts`)) return true; // test code would be compiled into the bundle
      const reached = layerOf(target);
      return !reached || !own?.reaches.includes(reached.at);
    }
    if (NEVER.some((pattern) => matches(pattern, specifier))) return true;
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
  return [...imports, ...globals.map((name) => `${file} uses ${name}`)];
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
    expect(sourceFiles().filter((file) => !isTestFile(file)).length).toBeGreaterThanOrEqual(4);
  });

  it('the checker reports an outward import', () => {
    expect(violationsOf('core/x.ts', "import { serve } from '../adapters/ws.js';")).toEqual([
      'core/x.ts imports ../adapters/ws.js',
    ]);
    expect(violationsOf('core/x.ts', "import { SignJWT } from 'jose';")).toEqual([
      'core/x.ts imports jose',
    ]);
  });

  it.each([
    ['import type', "import type { WebSocket } from 'ws';"],
    ['export … from', "export { WebSocket } from 'ws';"],
    ['export * from', "export * from 'ws';"],
    ['a side-effect import', "import 'ws';"],
    ['dynamic import()', "const loaded = await import('ws');"],
    ['typeof import()', "let loaded: typeof import('ws');"],
    ['require()', "const loaded = require('ws');"],
  ])('the checker reads %s', (_spelling, source) => {
    expect(violationsOf('core/x.ts', source)).toEqual(['core/x.ts imports ws']);
  });

  // One case for each rule in LAYERS and NEVER, spelled as a plain import.
  it.each([
    ['core/x.ts', './pass.ts', true],
    ['core/x.ts', '@t3tools/contracts', true],
    ['core/x.ts', 'node:crypto', false],
    ['core/x.ts', 'node:fs', false],
    ['core/x.ts', 'effect/process', false],
    ['core/x.ts', 'ws', false],
    ['core/x.ts', 'jose', false],
    ['core/x.ts', '../runtime/threads.ts', false],
    ['core/x.ts', '../adapters/ws.ts', false],
    ['core/x.ts', '../bin.ts', false],
    ['core/x.ts', './y.test.ts', false],
    ['core/x.ts', '../../../desktop/src/x.ts', false],
    ['runtime/x.ts', '../core/pass.ts', true],
    ['runtime/x.ts', '@t3tools/contracts', true],
    ['runtime/x.ts', 'effect', true],
    ['runtime/x.ts', '../adapters/ws.ts', false],
    ['runtime/x.ts', '../bin.ts', false],
    ['adapters/x.ts', '../core/pass.ts', true],
    ['adapters/x.ts', '../runtime/threads.ts', true],
    ['adapters/x.ts', 'ws', true],
    ['adapters/x.ts', 'jose', true],
    ['adapters/x.ts', 'node:fs', true],
    ['adapters/x.ts', '../bin.ts', false],
    ['bin.ts', './core/pass.ts', true],
    ['bin.ts', './runtime/threads.ts', true],
    ['bin.ts', './adapters/ws.ts', true],
    ['bin.ts', '@consola/factory-spec', false],
    ['adapters/x.ts', '@consola/automation-engine', false],
    ['core/x.test.ts', '../adapters/ws.ts', true],
    ['x.test.ts', '@consola/factory-spec', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it('the checker reports a file in no layer', () => {
    expect(violationsOf('stray.ts', 'export const a = 1;')).toEqual(['stray.ts is in no layer']);
  });

  // One case for each global `core` refuses.
  it.each([
    ['process', 'const home = process.env.HOME;'],
    ['fetch', "void fetch('/');"],
    ['require', 'const load = require;'],
    ['XMLHttpRequest', 'const request = new XMLHttpRequest();'],
    ['WebSocket', "const socket = new WebSocket('ws://sprocket.test');"],
    ['setTimeout', 'setTimeout(() => {}, 1);'],
    ['setInterval', 'setInterval(() => {}, 1);'],
    ['setImmediate', 'setImmediate(() => {});'],
    ['globalThis', 'const here = globalThis;'],
    ['global', 'const here = global;'],
    ['process', 'let here: typeof process;'],
    ['process', 'const reached = { process };'],
    ['fetch', "await globalThis.fetch('/');"],
    ['fetch', "await globalThis['fetch']('/');"],
  ])('the checker reports %s in core: %s', (name, source) => {
    expect(violationsOf('core/x.ts', source)).toContain(`core/x.ts uses ${name}`);
  });

  it('the checker does not take a member or a declaration for a global', () => {
    const source =
      'const request = { process: 1, fetch: 2 };\nexport const a = request.process + request.fetch;\nconst ws = 1;\nexport const b = ws;';
    expect(violationsOf('core/x.ts', source)).toEqual([]);
  });

  it('the outer rings may use globals', () => {
    expect(violationsOf('adapters/x.ts', 'const home = process.env.HOME;')).toEqual([]);
    expect(violationsOf('runtime/x.ts', 'setTimeout(() => {}, 1);')).toEqual([]);
  });

  it('a specifier that is not a plain string is refused', () => {
    expect(violationsOf('core/x.ts', 'const m = await import(name);')).toEqual([
      'core/x.ts imports <non-literal specifier>',
    ]);
  });
});
