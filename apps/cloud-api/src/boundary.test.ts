import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the dependency rule: imports point inward only. `domain` holds rules and types,
 * `application` the use cases and the ports they need, `adapters/*` what implements those ports
 * with a library, and the composition ring (`compose.ts`, `main.ts`, `startupError.ts`) wires
 * them together. `config.ts` is shared configuration that any adapter may read. Test files are
 * exempt from the layer rules, since they wire real pieces together the way the ring does.
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
};

const ADAPTERS = ['adapters/persistence', 'adapters/auth', 'adapters/http'];
const RING = ['compose', 'main', 'startupError'];

const LAYERS: Layer[] = [
  { at: 'domain', reaches: ['domain'], refuses: [ANY_PACKAGE] },
  { at: 'application', reaches: ['domain', 'application'], refuses: [ANY_PACKAGE] },
  {
    at: 'adapters/persistence',
    reaches: ['domain', 'application', 'adapters/persistence', 'config'],
    refuses: ['hono', '@hono/*', 'better-auth', '@better-auth/*'],
  },
  {
    at: 'adapters/auth',
    reaches: ['domain', 'application', 'adapters/auth', 'adapters/persistence', 'config'],
    refuses: ['hono', '@hono/*'],
  },
  {
    // Not `adapters/auth` either: that would bring Better Auth in through the side door.
    at: 'adapters/http',
    reaches: ['domain', 'application', 'adapters/http', 'config'],
    refuses: ['better-auth', '@better-auth/*', 'drizzle-orm', '@electric-sql/pglite', 'pg'],
  },
  // A pure parser of the environment, so it reaches no other file and no I/O.
  { at: 'config', reaches: [], refuses: [NODE_BUILTINS] },
  // The composition ring, where everything meets.
  ...RING.map((at) => ({
    at,
    reaches: ['domain', 'application', ...ADAPTERS, 'config', ...RING],
    refuses: [],
  })),
];

/** What every file, tests included, may never import: another app or a workspace package. */
const NEVER = ['@consola/*'];

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
 * Every way one file breaks the rule, as `<file> imports <specifier>` (or `<file> is in no
 * layer`). `file` is relative to `src/`; nothing is read from disk, so a test can feed it any
 * source.
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
    if (NEVER.some((pattern) => matches(pattern, specifier))) return true;
    if (test) return false;
    return own?.refuses.some((pattern) => matches(pattern, specifier)) ?? false;
  };

  return importsOf(source, file)
    .filter(broken)
    .map((specifier) => `${file} imports ${specifier}`);
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
    ['config.ts', 'zod', true],
    ['config.ts', 'node:fs', false],
    ['config.ts', './domain/organization.js', false],
    ['compose.ts', './adapters/http/app.js', true],
    ['compose.ts', '@consola/factory-spec', false],
    ['domain/x.ts', '../../../desktop/src/x.js', false],
    ['domain/x.ts', './y.test.js', false],
    ['domain/x.test.ts', '../adapters/http/app.js', true],
    ['x.test.ts', '../../desktop/src/x.js', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it('the checker refuses a file in no layer, and an import it cannot read', () => {
    expect(violationsOf('adapters/x.ts', '')).toEqual(['adapters/x.ts is in no layer']);
    expect(violationsOf('compose.ts', 'const loaded = await import(name);')).toEqual([
      `compose.ts imports ${NON_LITERAL}`,
    ]);
  });
});
