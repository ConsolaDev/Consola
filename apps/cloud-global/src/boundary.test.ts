import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the dependency rule: imports point inward only. `domain` holds rules and types,
 * `application` the use cases and the ports they need, `adapters/*` what implements those ports
 * with a library, and the composition ring (`compose.ts`, `main.ts`, `startupError.ts`) wires
 * them together. `config.ts` is shared configuration that any adapter may read. `domain` and
 * `application` also reach no global that touches the machine (`process`, `fetch`, timers).
 * Test files are exempt from the layer rules, since they wire real pieces together the way the
 * ring does. Of the workspace's packages, only the contract `cloud-global` shares with the cells
 * may be imported.
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

const ADAPTERS = ['adapters/persistence', 'adapters/auth', 'adapters/http', 'adapters/cellToken'];
const RING = ['compose', 'main', 'startupError'];

const LAYERS: Layer[] = [
  {
    at: 'domain',
    reaches: ['domain'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  {
    at: 'application',
    reaches: ['domain', 'application'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  {
    at: 'adapters/persistence',
    reaches: ['domain', 'application', 'adapters/persistence', 'config'],
    refuses: ['hono', '@hono/*', 'better-auth', '@better-auth/*', 'jose'],
    noGlobals: [],
  },
  {
    // No database library either: its hooks call use cases, and the stores run the queries.
    at: 'adapters/auth',
    reaches: ['domain', 'application', 'adapters/auth', 'adapters/persistence', 'config'],
    refuses: ['hono', '@hono/*', 'drizzle-orm', '@electric-sql/pglite', 'pg', 'jose'],
    noGlobals: [],
  },
  {
    // Not `adapters/auth` either: that would bring Better Auth in through the side door.
    at: 'adapters/http',
    reaches: ['domain', 'application', 'adapters/http', 'config'],
    refuses: ['better-auth', '@better-auth/*', 'drizzle-orm', '@electric-sql/pglite', 'pg', 'jose'],
    noGlobals: [],
  },
  {
    // Signing the cell token, with `jose`: the only place that holds the private key, and the
    // only one that imports `jose`.
    at: 'adapters/cellToken',
    reaches: ['domain', 'application', 'adapters/cellToken', 'config'],
    refuses: [
      'hono',
      '@hono/*',
      'better-auth',
      '@better-auth/*',
      'drizzle-orm',
      '@electric-sql/pglite',
      'pg',
    ],
    noGlobals: [],
  },
  // A pure parser of the environment, so it reaches no other file and no I/O.
  { at: 'config', reaches: [], refuses: [NODE_BUILTINS], noGlobals: [] },
  // The composition ring, where everything meets.
  ...RING.map((at) => ({
    at,
    reaches: ['domain', 'application', ...ADAPTERS, 'config', ...RING],
    refuses: [],
    noGlobals: [],
  })),
];

/**
 * The one workspace package any file may import, from any layer: the contract `cloud-global`
 * shares with the cells (`packages/cloud-contract`). It does no I/O, which its own boundary test
 * proves, so `domain` and `application` may import it, and it is the only package they may. Only
 * its entry point counts: a path inside it is refused like any other workspace package.
 */
const CLOUD_CONTRACT = '@consola/cloud-contract';

/**
 * What every file, tests included, may never import: another app or a workspace package but the
 * contract (`consola` is the desktop app's name).
 */
const NEVER = ['@consola/*', 'consola'];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const isTestFile = (file: string): boolean => /\.test\.(?:[cm]?[jt]s|tsx)$/.test(file);

/** Stand-in for an import whose specifier is not a plain string, which nothing can check. */
const NON_LITERAL = '<non-literal specifier>';

/**
 * Every module specifier a source file imports, however it spells it: `import`, `import type`,
 * `export … from`, `import x = require()`, `require()`, dynamic `import()` and `typeof
 * import()`. It reads the syntax tree, so comments and strings never count. The file name picks
 * the parser, so `.tsx` is read as TSX.
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
 * Every name a source file refers to, as a value or a type, in the order it appears. A name is
 * not a reference when it is a property's or a member's own name (`request.process`,
 * `{ fetch: 1 }`, a method, a type member, a JSX attribute), when it is being declared (a
 * variable, a parameter, a destructured property, a function, a class, an import), or when it is
 * `require` called as an import, which `importsOf` judges by what it loads. A member of
 * `globalThis` (or `global`, `window`, `self`) refers to the global it names. It does not follow
 * scopes, so a local that shares a global's name is reported where it is read.
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
      ts.isJsxAttribute(parent) ||
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
      if (isTestFile(`${target}.ts`)) return true; // test code would be compiled into dist
      const reached = layerOf(target);
      return !reached || !own?.reaches.includes(reached.at);
    }
    if (specifier === CLOUD_CONTRACT) return false;
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

/** The name of every package in the workspace: each folder in `apps/` and `packages/`. */
function workspacePackages(): string[] {
  const root = join(SRC, '..', '..', '..');
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group), { withFileTypes: true })
      .map((entry) => join(root, group, entry.name, 'package.json'))
      .filter((manifest) => existsSync(manifest))
      .map((manifest) => (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string }).name),
  );
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
    expect(sourceFiles().filter((file) => !isTestFile(file)).length).toBeGreaterThan(15);
  });

  it('the checker reports an outward import', () => {
    expect(
      violationsOf('domain/x.ts', "import { createApp } from '../adapters/http/app.js';"),
    ).toEqual(['domain/x.ts imports ../adapters/http/app.js']);
    expect(violationsOf('domain/x.ts', "import { sql } from 'drizzle-orm';")).toEqual([
      'domain/x.ts imports drizzle-orm',
    ]);
  });

  it.each([
    ['import type', "import type { Hono } from 'hono';"],
    ['export … from', "export { Hono } from 'hono';"],
    ['export * from', "export * from 'hono';"],
    ['a side-effect import', "import 'hono';"],
    ['dynamic import()', "const loaded = await import('hono');"],
    ['typeof import()', "let loaded: typeof import('hono');"],
    ['require()', "const loaded = require('hono');"],
  ])('the checker reads %s', (_spelling, source) => {
    expect(violationsOf('application/x.ts', source)).toEqual(['application/x.ts imports hono']);
  });

  it('the checker reads a .tsx file', () => {
    const source = "import { Hono } from 'hono';\nexport const view = <div />;";
    expect(violationsOf('domain/x.tsx', source)).toEqual(['domain/x.tsx imports hono']);
  });

  // One case for each rule in LAYERS and NEVER, spelled as a plain import.
  it.each([
    ['domain/x.ts', './joinRule.js', true],
    ['domain/x.ts', '../application/ports.js', false],
    ['domain/x.ts', 'node:crypto', false],
    ['application/x.ts', '../domain/joinRule.js', true],
    ['application/x.ts', '../adapters/auth/betterAuth.js', false],
    ['application/x.ts', 'zod', false],
    ['adapters/persistence/x.ts', 'drizzle-orm', true],
    ['adapters/persistence/x.ts', '../../config.js', true],
    ['adapters/persistence/x.ts', 'hono', false],
    ['adapters/persistence/x.ts', 'better-auth', false],
    ['adapters/persistence/x.ts', '@better-auth/drizzle-adapter', false],
    ['adapters/persistence/x.ts', '../auth/betterAuth.js', false],
    ['adapters/persistence/x.ts', '../../startupError.js', false],
    ['adapters/auth/x.ts', 'better-auth', true],
    ['adapters/auth/x.ts', '../persistence/database.js', true],
    ['adapters/auth/x.ts', 'hono', false],
    ['adapters/auth/x.ts', 'drizzle-orm', false],
    ['adapters/auth/x.ts', 'pg', false],
    ['adapters/auth/x.ts', '@electric-sql/pglite', false],
    ['adapters/auth/x.ts', '../http/app.js', false],
    ['adapters/auth/x.ts', '../../compose.js', false],
    ['adapters/http/x.ts', 'hono', true],
    ['adapters/http/x.ts', 'better-auth/plugins', false],
    ['adapters/http/x.ts', 'drizzle-orm', false],
    ['adapters/http/x.ts', '@electric-sql/pglite', false],
    ['adapters/http/x.ts', 'pg', false],
    ['adapters/http/x.ts', '../persistence/database.js', false],
    ['adapters/http/x.ts', '../auth/betterAuth.js', false],
    ['adapters/http/x.ts', '../../main.js', false],
    ['adapters/http/x.ts', 'jose', false],
    ['adapters/http/x.ts', '../cellToken/cellTokenSigner.js', false],
    ['adapters/persistence/x.ts', 'jose', false],
    ['adapters/auth/x.ts', 'jose', false],
    ['adapters/cellToken/x.ts', 'jose', true],
    ['adapters/cellToken/x.ts', 'node:crypto', true],
    ['adapters/cellToken/x.ts', '../../config.js', true],
    ['adapters/cellToken/x.ts', '../../application/ports.js', true],
    ['adapters/cellToken/x.ts', 'hono', false],
    ['adapters/cellToken/x.ts', 'better-auth', false],
    ['adapters/cellToken/x.ts', 'drizzle-orm', false],
    ['adapters/cellToken/x.ts', 'pg', false],
    ['adapters/cellToken/x.ts', '../persistence/database.js', false],
    ['adapters/cellToken/x.ts', '../http/app.js', false],
    ['adapters/cellToken/x.ts', '../../compose.js', false],
    ['adapters/cellToken/x.ts', '@consola/cloud-contract', true],
    ['domain/x.ts', 'jose', false],
    ['application/x.ts', 'jose', false],
    ['compose.ts', './adapters/cellToken/cellTokenSigner.js', true],
    ['config.ts', 'zod', true],
    ['config.ts', 'node:fs', false],
    ['config.ts', './domain/organization.js', false],
    ['compose.ts', './adapters/http/app.js', true],
    ['compose.ts', '@consola/factory-spec', false],
    ['domain/x.ts', '../../../desktop/src/x.js', false],
    ['domain/x.ts', './y.test.js', false],
    ['domain/x.test.ts', '../adapters/http/app.js', true],
    ['x.test.ts', '../../desktop/src/x.js', false],
    ['domain/x.ts', '@consola/cloud-contract', true],
    ['application/x.ts', '@consola/cloud-contract', true],
    ['adapters/persistence/x.ts', '@consola/cloud-contract', true],
    ['adapters/auth/x.ts', '@consola/cloud-contract', true],
    ['adapters/http/x.ts', '@consola/cloud-contract', true],
    ['config.ts', '@consola/cloud-contract', true],
    ['compose.ts', '@consola/cloud-contract', true],
    ['x.test.ts', '@consola/cloud-contract', true],
    ['domain/x.ts', '@consola/cloud-contract/dist/region.js', false],
    ['compose.ts', '@consola/cloud-contracts', false],
    ['domain/x.ts', '../../../../packages/cloud-contract/src/region.js', false],
    ['compose.ts', 'consola', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it('the checker refuses every workspace package but the contract, wherever it is imported', () => {
    const packages = workspacePackages();
    expect(packages).toContain(CLOUD_CONTRACT);
    expect(packages).toContain('@consola/cloud-global');
    expect(packages.length).toBeGreaterThan(5);
    // The ring refuses no package of its own and tests are exempt from the layer rules, so only
    // NEVER stands between them and a workspace package.
    for (const file of ['compose.ts', 'adapters/http/x.ts', 'domain/x.ts', 'x.test.ts']) {
      for (const name of packages.filter((p) => p !== CLOUD_CONTRACT)) {
        expect(violationsOf(file, `import x from '${name}';`)).toEqual([`${file} imports ${name}`]);
      }
    }
  });

  it('the checker reports a global that reaches the machine', () => {
    expect(violationsOf('domain/x.ts', 'const home = process.env.HOME;')).toEqual([
      'domain/x.ts uses process',
    ]);
    expect(violationsOf('application/x.ts', "await fetch('https://sprocket.test');")).toEqual([
      'application/x.ts uses fetch',
    ]);
  });

  // One case for each global `domain` and `application` refuse.
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
  ])('the checker reports %s in the inner layers: %s', (name, source) => {
    expect(violationsOf('domain/x.ts', source)).toEqual([`domain/x.ts uses ${name}`]);
    expect(violationsOf('application/x.ts', source)).toEqual([`application/x.ts uses ${name}`]);
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
    ['require called as an import', "const a = require('./y.js');"],
  ])('the checker does not report %s', (_name, source) => {
    expect(violationsOf('domain/x.ts', source)).toEqual([]);
  });

  it('the checker lets adapters, the ring and tests reach the machine', () => {
    expect(violationsOf('adapters/persistence/x.ts', 'const a = process.env.HOME;')).toEqual([]);
    expect(violationsOf('main.ts', 'process.exit(1);')).toEqual([]);
    expect(violationsOf('domain/x.test.ts', "process.env.X = '1';")).toEqual([]);
  });

  it('the checker refuses a file in no layer, and an import it cannot read', () => {
    expect(violationsOf('adapters/x.ts', '')).toEqual(['adapters/x.ts is in no layer']);
    expect(violationsOf('compose.ts', 'const loaded = await import(name);')).toEqual([
      `compose.ts imports ${NON_LITERAL}`,
    ]);
  });
});
