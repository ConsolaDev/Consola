import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, posix } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the two parts apart and the dependency rule inside each.
 *
 * - **The parts.** `accounts/` (people, sign-in, sessions, workspaces, membership) and
 *   `company/` (what a workspace holds, GitHub included). `company` never imports `accounts`,
 *   Better Auth (`better-auth`, `@better-auth/*`), tests included; `accounts` never imports
 *   `company`. Both may import `shared/`, which imports nothing but itself and does no I/O.
 *   Only the composition ring (`compose.ts`, `main.ts`, `startupError.ts`, `seed.ts`, `http/`,
 *   `persistence/` and the suites' `testing/`) imports both parts.
 * - **Inside each part, imports point inward only.** `domain` holds rules and types,
 *   `application` the use cases and the ports they need, `adapters/*` what implements those ports
 *   with a library. `config.ts` is shared configuration that any adapter may read. `domain`,
 *   `application` and `shared` reach no global that touches the machine (`process`, `fetch`,
 *   timers).
 * - **Workspace packages.** Only `@consola/runner-protocol` and `@consola/factory-spec`, by their
 *   entry points, and only from `company` (and the ring's tests, which drive it).
 * - **Tests** are exempt from the layer rules, since they wire real pieces together the way the
 *   ring does, except that a part's files, tests or not, leave their part only for what both parts
 *   share (`PART_MAY_REACH`: `shared/` and `config.ts`): never the other part, and never the ring
 *   (`compose.ts`, `persistence/`, `http/`, `testing/`…), which brings the other part and Better
 *   Auth in. So company's tests use a fake `MembershipReader`. Nothing but a test imports
 *   `testing/`.
 */

const SRC = import.meta.dirname;

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

const DATABASE_LIBRARIES = ['drizzle-orm', '@electric-sql/pglite', 'pg'];
const HTTP_LIBRARIES = ['hono', '@hono/*'];
const AUTH_LIBRARIES = ['better-auth', '@better-auth/*'];
/** What signs a session's pass, which only `company/adapters/token` may hold. */
const TOKEN_LIBRARIES = ['jose'];

const ACCOUNTS_ADAPTERS = [
  'accounts/adapters/persistence',
  'accounts/adapters/auth',
  'accounts/adapters/http',
];
const COMPANY_ADAPTERS = [
  'company/adapters/persistence',
  'company/adapters/http',
  'company/adapters/github',
  'company/adapters/token',
  'company/adapters/clock',
  'company/adapters/runner',
];
const ACCOUNTS = ['accounts/domain', 'accounts/application', ...ACCOUNTS_ADAPTERS];
const COMPANY = ['company/domain', 'company/application', ...COMPANY_ADAPTERS];

/** The ring's files and folders, where both parts meet. `testing/` is apart: tests alone use it. */
const RING = ['compose', 'main', 'startupError', 'seed', 'http', 'persistence'];

/**
 * All a part's files may reach outside their part, tests included, each with why. Everything
 * else outside a part is the other part or the ring, and the ring (`compose.ts`, `persistence/`,
 * `http/`, `testing/`…) brings the other part and Better Auth in. A non-test file is held to its
 * layer too, so of these only an adapter reads `config`.
 */
const PART_MAY_REACH: Record<string, string> = {
  shared: 'the regions and the workspace roles, which both parts use, with no I/O',
  config:
    "shared configuration, which adapters read: Better Auth's, the GitHub App's and the pass key's",
};

/** Whether a path under `src/` (no extension) is one a part's file may reach outside its part. */
const partMayReach = (path: string): boolean =>
  Object.keys(PART_MAY_REACH).some((at) => path === at || path.startsWith(`${at}/`));

/** An adapter of one part: its part's inner layers, its own folder, `shared` and `config`. */
const adapter = (
  part: 'accounts' | 'company',
  at: string,
  refuses: string[],
  alsoReaches: string[] = [],
): Layer => ({
  at,
  reaches: [`${part}/domain`, `${part}/application`, at, ...alsoReaches, 'shared', 'config'],
  refuses,
  noGlobals: [],
});

const LAYERS: Layer[] = [
  // Regions and roles, which both parts use: plain TypeScript, no I/O.
  { at: 'shared', reaches: ['shared'], refuses: [ANY_PACKAGE], noGlobals: MACHINE_GLOBALS },

  // accounts.
  {
    at: 'accounts/domain',
    reaches: ['accounts/domain', 'shared'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  {
    at: 'accounts/application',
    reaches: ['accounts/domain', 'accounts/application', 'shared'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  adapter('accounts', 'accounts/adapters/persistence', [
    ...HTTP_LIBRARIES,
    ...AUTH_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),
  // No database library: its hooks call use cases, and the stores run the queries. It may reach
  // `persistence`, since Better Auth's Drizzle adapter needs the database and its schema.
  adapter(
    'accounts',
    'accounts/adapters/auth',
    [...HTTP_LIBRARIES, ...DATABASE_LIBRARIES, ...TOKEN_LIBRARIES],
    ['accounts/adapters/persistence'],
  ),
  // Not `adapters/auth` either: that would bring Better Auth in through the side door.
  adapter('accounts', 'accounts/adapters/http', [
    ...AUTH_LIBRARIES,
    ...DATABASE_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),

  // company.
  {
    at: 'company/domain',
    reaches: ['company/domain', 'shared'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  {
    at: 'company/application',
    reaches: ['company/domain', 'company/application', 'shared'],
    refuses: [ANY_PACKAGE],
    noGlobals: MACHINE_GLOBALS,
  },
  adapter('company', 'company/adapters/persistence', [
    ...HTTP_LIBRARIES,
    ...AUTH_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),
  adapter('company', 'company/adapters/http', [
    ...DATABASE_LIBRARIES,
    ...AUTH_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),
  // GitHub's REST API, with `fetch` and `node:crypto`: the only place that holds the GitHub App's
  // private key and client secret. No HTTP framework, no database, and not `jose`.
  adapter('company', 'company/adapters/github', [
    ...HTTP_LIBRARIES,
    ...DATABASE_LIBRARIES,
    ...AUTH_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),
  // The pass is signed with jose here, and only here.
  adapter('company', 'company/adapters/token', [
    ...DATABASE_LIBRARIES,
    ...HTTP_LIBRARIES,
    ...AUTH_LIBRARIES,
  ]),
  // The machine's clock needs no library at all.
  adapter('company', 'company/adapters/clock', [ANY_PACKAGE]),
  // The runners' channel and their socket, a route of its own (`hono`, `@hono/node-ws`): no
  // database, and no token library, since the pass is signed in `adapters/token`.
  adapter('company', 'company/adapters/runner', [
    ...DATABASE_LIBRARIES,
    ...AUTH_LIBRARIES,
    ...TOKEN_LIBRARIES,
  ]),

  // A pure parser of the environment: no I/O, and nothing but `shared`, whose regions it checks.
  { at: 'config', reaches: ['shared'], refuses: [NODE_BUILTINS], noGlobals: [] },

  // The ring. The front door and the health check know neither part: they are handed probes.
  {
    at: 'http',
    reaches: ['http', 'shared'],
    refuses: [...DATABASE_LIBRARIES, ...AUTH_LIBRARIES, ...TOKEN_LIBRARIES],
    noGlobals: [],
  },
  // The one database: both parts' tables and the hand-over of a workspace's transaction.
  {
    at: 'persistence',
    reaches: [
      'persistence',
      'accounts/adapters/persistence',
      'company/adapters/persistence',
      'shared',
    ],
    refuses: [...HTTP_LIBRARIES, ...AUTH_LIBRARIES, ...TOKEN_LIBRARIES],
    noGlobals: [],
  },
  // Where everything meets.
  ...['compose', 'main', 'startupError', 'seed'].map((at) => ({
    at,
    reaches: [...ACCOUNTS, ...COMPANY, 'shared', 'config', ...RING],
    refuses: [],
    noGlobals: [],
  })),
  // The HTTP suites' helpers: they build the app as the ring does. Only a test reaches them.
  {
    at: 'testing',
    reaches: [...ACCOUNTS, ...COMPANY, 'shared', 'config', ...RING, 'testing'],
    refuses: [],
    noGlobals: [],
  },
];

/**
 * The workspace packages `company` may import, from any layer, by their entry point alone:
 * `@consola/runner-protocol`, what the app and its runners say to each other, and
 * `@consola/factory-spec`, the factory files' schema. Each does no I/O, which its own boundary
 * test proves. The ring's tests may import them too, to drive company as a runner would.
 */
const RUNNER_PROTOCOL = '@consola/runner-protocol';
const FACTORY_SPEC = '@consola/factory-spec';
const SHARED_PACKAGES = new Set([RUNNER_PROTOCOL, FACTORY_SPEC]);

/**
 * What every file, tests included, may never import: another app or a workspace package but the
 * shared ones (`consola` is the desktop app's name).
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

/** Which part a path under `src/` is in, or null for `shared` and the ring. */
function partOf(path: string): 'accounts' | 'company' | null {
  if (path.startsWith('accounts/')) return 'accounts';
  if (path.startsWith('company/')) return 'company';
  return null;
}

/**
 * Every way one file breaks the rules, as `<file> imports <specifier>`, `<file> uses <global>`
 * (or `<file> is in no layer`). `file` is relative to `src/`; nothing is read from disk, so a
 * test can feed it any source.
 */
function violationsOf(file: string, source: string): string[] {
  const test = isTestFile(file);
  const own = layerOf(file.replace(SOURCE_EXTENSION, ''));
  if (!test && !own) return [`${file} is in no layer`];
  const part = partOf(file);

  const broken = (specifier: string): boolean => {
    if (specifier === NON_LITERAL) return true;
    if (specifier.startsWith('.')) {
      const target = posix.join(posix.dirname(file), specifier).replace(SOURCE_EXTENSION, '');
      if (target === '..' || target.startsWith('../')) return true; // leaves src/
      // A part's file, a test included, leaves its part only for what both parts share: never for
      // the other part, nor for the ring, which brings it in.
      if (part !== null && partOf(target) !== part && !partMayReach(target)) return true;
      if (test) return false;
      if (isTestFile(`${target}.ts`)) return true; // test code would be compiled into dist
      const reached = layerOf(target);
      return !reached || !own?.reaches.includes(reached.at);
    }
    if (SHARED_PACKAGES.has(specifier)) return !(part === 'company' || (test && part === null));
    if (NEVER.some((pattern) => matches(pattern, specifier))) return true;
    // Company holds no accounts: not even its tests bring Better Auth in.
    if (part === 'company' && AUTH_LIBRARIES.some((pattern) => matches(pattern, specifier))) {
      return true;
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
  it('every source file keeps the dependency rule and the boundary', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsOf(file, readFileSync(join(SRC, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });

  it('names only layers that exist as what a part may reach outside itself', () => {
    expect(Object.keys(PART_MAY_REACH).filter((at) => layerOf(at)?.at !== at)).toEqual([]);
  });

  it('the checker sees both parts and the ring', () => {
    const files = sourceFiles().filter((file) => !isTestFile(file));
    expect(files.filter((file) => file.startsWith('accounts/')).length).toBeGreaterThan(15);
    expect(files.filter((file) => file.startsWith('company/')).length).toBeGreaterThan(30);
    expect(files).toEqual(expect.arrayContaining(['compose.ts', 'main.ts', 'config.ts']));
  });

  it('the checker reports an outward import', () => {
    expect(
      violationsOf('company/domain/x.ts', "import { createApp } from '../adapters/http/app.js';"),
    ).toEqual(['company/domain/x.ts imports ../adapters/http/app.js']);
    expect(violationsOf('accounts/domain/x.ts', "import { sql } from 'drizzle-orm';")).toEqual([
      'accounts/domain/x.ts imports drizzle-orm',
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
    expect(violationsOf('company/application/x.ts', source)).toEqual([
      'company/application/x.ts imports hono',
    ]);
  });

  it('the checker reads a .tsx file', () => {
    const source = "import { Hono } from 'hono';\nexport const view = <div />;";
    expect(violationsOf('accounts/domain/x.tsx', source)).toEqual([
      'accounts/domain/x.tsx imports hono',
    ]);
  });

  // The boundary between the parts, and who may cross it.
  it.each([
    ['company/domain/x.ts', '../../accounts/domain/person.js', false],
    ['company/adapters/http/x.ts', '../../../accounts/adapters/auth/betterAuth.js', false],
    [
      'company/adapters/persistence/x.ts',
      '../../../accounts/adapters/persistence/schema.js',
      false,
    ],
    ['accounts/domain/x.ts', '../../company/domain/caller.js', false],
    ['accounts/adapters/persistence/x.ts', '../../../company/adapters/persistence/teams.js', false],
    ['company/domain/x.ts', '../../shared/workspaceRole.js', true],
    ['accounts/application/x.ts', '../../shared/region.js', true],
    ['shared/x.ts', './region.js', true],
    ['shared/x.ts', '../accounts/domain/person.js', false],
    ['shared/x.ts', '../company/domain/caller.js', false],
    ['shared/x.ts', '../config.js', false],
    ['shared/x.ts', 'zod', false],
    // Tests keep their exemption, but not across the parts.
    [
      'company/application/x.test.ts',
      '../../accounts/adapters/persistence/membershipReader.js',
      false,
    ],
    ['company/adapters/http/x.test.ts', '../../../accounts/domain/person.js', false],
    ['accounts/adapters/persistence/x.test.ts', '../../../company/application/ports.js', false],
    ['company/application/x.test.ts', '../adapters/persistence/testDatabase.js', true],
    // Nor out of their part at all, but for what both parts share: the ring brings the other
    // part and Better Auth in.
    ['company/application/x.test.ts', '../../compose.js', false],
    ['company/application/x.test.ts', '../../persistence/database.js', false],
    ['company/application/x.test.ts', '../../shared/region.js', true],
    ['company/adapters/github/x.test.ts', '../../../config.js', true],
    ['company/adapters/persistence/x.test.ts', '../../../seed.js', false],
    ['company/x.test.ts', '../compose.js', false],
    ['accounts/adapters/http/x.test.ts', '../../../http/frontDoor.js', false],
    ['accounts/adapters/auth/x.test.ts', '../../../startupError.js', false],
    ['accounts/domain/x.test.ts', '../../main.js', false],
    ['accounts/domain/x.test.ts', '../../shared/workspaceRole.js', true],
    ['company/application/x.test.ts', 'better-auth', false],
    ['company/adapters/http/x.test.ts', 'better-auth/plugins', false],
    ['company/adapters/http/x.test.ts', '@better-auth/drizzle-adapter', false],
    ['accounts/adapters/auth/x.test.ts', 'better-auth/plugins', true],
    // Only the ring meets both parts.
    ['compose.ts', './accounts/adapters/http/app.js', true],
    ['compose.ts', './company/adapters/http/app.js', true],
    ['main.ts', './persistence/database.js', true],
    ['persistence/x.ts', '../accounts/adapters/persistence/schema.js', true],
    ['persistence/x.ts', '../company/adapters/persistence/teams.js', true],
    ['persistence/x.ts', '../company/adapters/http/app.js', false],
    ['persistence/x.ts', '../accounts/adapters/auth/betterAuth.js', false],
    ['persistence/x.ts', 'hono', false],
    ['persistence/x.ts', 'drizzle-orm', true],
    ['http/x.ts', '@hono/zod-openapi', true],
    ['http/x.ts', '../accounts/adapters/http/app.js', false],
    ['http/x.ts', '../company/adapters/http/app.js', false],
    ['http/x.ts', 'drizzle-orm', false],
    ['http/x.ts', 'better-auth', false],
    ['x.test.ts', './accounts/adapters/http/app.js', true],
    ['x.test.ts', './company/adapters/http/app.js', true],
    // Only a test reaches the suites' helpers.
    ['x.test.ts', './testing/harness.js', true],
    ['company/adapters/http/x.test.ts', '../../../testing/harness.js', false],
    ['accounts/domain/x.test.ts', '../../testing/harness.js', false],
    ['compose.ts', './testing/harness.js', false],
    ['company/domain/x.ts', '../../testing/harness.js', false],
    ['testing/x.ts', '../compose.js', true],
    ['testing/x.ts', '../accounts/adapters/persistence/schema.js', true],
    ['testing/x.ts', 'better-auth/plugins', true],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  // One case for each rule in LAYERS and NEVER, spelled as a plain import.
  it.each([
    // accounts.
    ['accounts/domain/x.ts', './joinRule.js', true],
    ['accounts/domain/x.ts', '../application/ports.js', false],
    ['accounts/domain/x.ts', 'node:crypto', false],
    ['accounts/application/x.ts', '../domain/joinRule.js', true],
    ['accounts/application/x.ts', '../adapters/auth/betterAuth.js', false],
    ['accounts/application/x.ts', 'zod', false],
    ['accounts/adapters/persistence/x.ts', 'drizzle-orm', true],
    ['accounts/adapters/persistence/x.ts', '../../../config.js', true],
    ['accounts/adapters/persistence/x.ts', 'hono', false],
    ['accounts/adapters/persistence/x.ts', 'better-auth', false],
    ['accounts/adapters/persistence/x.ts', '@better-auth/drizzle-adapter', false],
    ['accounts/adapters/persistence/x.ts', '../auth/betterAuth.js', false],
    ['accounts/adapters/persistence/x.ts', '../../../startupError.js', false],
    ['accounts/adapters/persistence/x.ts', '../../../persistence/database.js', false],
    ['accounts/adapters/persistence/x.ts', 'jose', false],
    ['accounts/adapters/auth/x.ts', 'better-auth', true],
    ['accounts/adapters/auth/x.ts', '../persistence/database.js', true],
    ['accounts/adapters/auth/x.ts', '../../../config.js', true],
    ['accounts/adapters/auth/x.ts', 'hono', false],
    ['accounts/adapters/auth/x.ts', 'drizzle-orm', false],
    ['accounts/adapters/auth/x.ts', 'pg', false],
    ['accounts/adapters/auth/x.ts', '@electric-sql/pglite', false],
    ['accounts/adapters/auth/x.ts', '../http/app.js', false],
    ['accounts/adapters/auth/x.ts', '../../../compose.js', false],
    ['accounts/adapters/auth/x.ts', 'jose', false],
    ['accounts/adapters/http/x.ts', 'hono', true],
    ['accounts/adapters/http/x.ts', '../../../shared/workspaceRole.js', true],
    ['accounts/adapters/http/x.ts', 'better-auth/plugins', false],
    ['accounts/adapters/http/x.ts', 'drizzle-orm', false],
    ['accounts/adapters/http/x.ts', '@electric-sql/pglite', false],
    ['accounts/adapters/http/x.ts', 'pg', false],
    ['accounts/adapters/http/x.ts', '../persistence/database.js', false],
    ['accounts/adapters/http/x.ts', '../auth/betterAuth.js', false],
    ['accounts/adapters/http/x.ts', '../../../main.js', false],
    ['accounts/adapters/http/x.ts', 'jose', false],
    // company.
    ['company/domain/x.ts', './team.js', true],
    ['company/domain/x.ts', '../application/ports.js', false],
    ['company/domain/x.ts', 'node:crypto', false],
    ['company/domain/x.ts', 'jose', false],
    ['company/application/x.ts', '../domain/team.js', true],
    ['company/application/x.ts', '../adapters/http/app.js', false],
    ['company/application/x.ts', 'zod', false],
    ['company/application/x.ts', 'jose', false],
    ['company/adapters/persistence/x.ts', 'drizzle-orm', true],
    ['company/adapters/persistence/x.ts', 'node:crypto', true],
    ['company/adapters/persistence/x.ts', '../../../config.js', true],
    ['company/adapters/persistence/x.ts', 'hono', false],
    ['company/adapters/persistence/x.ts', '@hono/node-server', false],
    ['company/adapters/persistence/x.ts', '@hono/node-ws', false],
    ['company/adapters/persistence/x.ts', '../http/app.js', false],
    ['company/adapters/persistence/x.ts', '../../../startupError.js', false],
    ['company/adapters/persistence/x.ts', 'jose', false],
    ['company/adapters/http/x.ts', 'hono', true],
    ['company/adapters/http/x.ts', '@hono/node-ws', true],
    ['company/adapters/http/x.ts', '../../domain/caller.js', true],
    ['company/adapters/http/x.ts', 'drizzle-orm', false],
    ['company/adapters/http/x.ts', '@electric-sql/pglite', false],
    ['company/adapters/http/x.ts', 'pg', false],
    ['company/adapters/http/x.ts', '../persistence/database.js', false],
    ['company/adapters/http/x.ts', '../../../main.js', false],
    ['company/adapters/http/x.ts', 'jose', false],
    ['company/adapters/http/x.ts', '../token/passSigner.js', false],
    ['company/adapters/http/x.ts', '../runner/runnerSocket.js', false],
    ['company/adapters/http/x.ts', '../runner/noRunner.js', false],
    ['company/adapters/github/x.ts', 'node:crypto', true],
    ['company/adapters/github/x.ts', '../../../config.js', true],
    ['company/adapters/github/x.ts', '../../application/gitHubPorts.js', true],
    ['company/adapters/github/x.ts', 'hono', false],
    ['company/adapters/github/x.ts', 'drizzle-orm', false],
    ['company/adapters/github/x.ts', 'jose', false],
    ['company/adapters/github/x.ts', '../persistence/installationStore.js', false],
    ['company/adapters/token/x.ts', 'jose', true],
    ['company/adapters/token/x.ts', '../../application/ports.js', true],
    ['company/adapters/token/x.ts', '../../../config.js', true],
    ['company/adapters/token/x.ts', 'hono', false],
    ['company/adapters/token/x.ts', 'drizzle-orm', false],
    ['company/adapters/token/x.ts', '@hono/node-ws', false],
    ['company/adapters/token/x.ts', '../http/app.js', false],
    ['company/adapters/token/x.ts', '../runner/runnerSocket.js', false],
    ['company/adapters/token/x.ts', '../../../compose.js', false],
    ['company/adapters/clock/x.ts', '../../application/ports.js', true],
    ['company/adapters/clock/x.ts', 'jose', false],
    ['company/adapters/clock/x.ts', 'node:perf_hooks', false],
    ['company/adapters/clock/x.ts', '../token/passSigner.js', false],
    ['company/adapters/runner/x.ts', '../../application/ports.js', true],
    ['company/adapters/runner/x.ts', 'hono', true],
    ['company/adapters/runner/x.ts', 'hono/ws', true],
    ['company/adapters/runner/x.ts', '@hono/node-ws', true],
    ['company/adapters/runner/x.ts', '../../../config.js', true],
    ['company/adapters/runner/x.ts', 'node:crypto', true],
    ['company/adapters/runner/x.ts', 'drizzle-orm', false],
    ['company/adapters/runner/x.ts', '@electric-sql/pglite', false],
    ['company/adapters/runner/x.ts', 'jose', false],
    ['company/adapters/runner/x.ts', '../http/app.js', false],
    ['company/adapters/runner/x.ts', '../token/passSigner.js', false],
    ['company/adapters/runner/x.ts', '../persistence/cloudSessions.js', false],
    ['company/adapters/runner/x.ts', '../../../compose.js', false],
    // config and the ring.
    ['config.ts', 'zod', true],
    ['config.ts', './shared/region.js', true],
    ['config.ts', 'node:fs', false],
    ['config.ts', './company/application/ports.js', false],
    ['config.ts', './accounts/domain/person.js', false],
    ['config.ts', './compose.js', false],
    ['compose.ts', './company/adapters/token/passSigner.js', true],
    ['compose.ts', './company/adapters/runner/runnerSocket.js', true],
    ['compose.ts', './company/adapters/clock/systemClock.js', true],
    ['compose.ts', './accounts/adapters/auth/betterAuth.js', true],
    ['compose.ts', './http/frontDoor.js', true],
    ['compose.ts', 'jose', true],
    ['compose.ts', 'better-auth', true],
    ['seed.ts', './company/application/seedDemoRuns.js', true],
    ['seed.ts', './accounts/adapters/persistence/membershipReader.js', true],
    ['company/domain/x.ts', './y.test.js', false],
    ['company/domain/x.test.ts', '../adapters/http/app.js', true],
    ['company/domain/x.ts', '../../../desktop/src/x.js', false],
    ['x.test.ts', '../../desktop/src/x.js', false],
    ['compose.ts', 'consola', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  // The two workspace packages, from company alone.
  it.each([
    ['company/domain/x.ts', RUNNER_PROTOCOL, true],
    ['company/application/x.ts', RUNNER_PROTOCOL, true],
    ['company/adapters/persistence/x.ts', RUNNER_PROTOCOL, true],
    ['company/adapters/http/x.ts', RUNNER_PROTOCOL, true],
    ['company/adapters/runner/x.ts', RUNNER_PROTOCOL, true],
    ['company/adapters/token/x.ts', RUNNER_PROTOCOL, true],
    ['company/domain/x.ts', FACTORY_SPEC, true],
    ['company/application/x.ts', FACTORY_SPEC, true],
    ['company/adapters/http/x.ts', FACTORY_SPEC, true],
    ['company/application/x.test.ts', FACTORY_SPEC, true],
    ['x.test.ts', RUNNER_PROTOCOL, true],
    ['x.test.ts', FACTORY_SPEC, true],
    ['accounts/domain/x.ts', RUNNER_PROTOCOL, false],
    ['accounts/adapters/http/x.ts', FACTORY_SPEC, false],
    ['accounts/application/x.test.ts', FACTORY_SPEC, false],
    ['shared/x.ts', FACTORY_SPEC, false],
    ['config.ts', RUNNER_PROTOCOL, false],
    ['compose.ts', RUNNER_PROTOCOL, false],
    ['compose.ts', FACTORY_SPEC, false],
    ['company/domain/x.ts', '@consola/runner-protocol/dist/messages.js', false],
    ['company/domain/x.ts', '../../../../packages/runner-protocol/src/messages.js', false],
    ['company/domain/x.ts', '@consola/factory-spec/dist/factory.js', false],
    ['compose.ts', '@consola/runner-protocols', false],
    ['company/domain/x.ts', '@consola/cloud-contract', false],
    ['x.test.ts', '@consola/cloud-contract', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it('the checker refuses every workspace package but the shared ones, wherever it is imported', () => {
    const packages = workspacePackages();
    expect(packages).toContain(RUNNER_PROTOCOL);
    expect(packages).toContain(FACTORY_SPEC);
    expect(packages).toContain('@consola/cloud-api');
    expect(packages.length).toBeGreaterThan(5);
    // The ring refuses no package of its own and tests are exempt from the layer rules, so only
    // NEVER stands between them and a workspace package.
    for (const file of [
      'compose.ts',
      'company/adapters/http/x.ts',
      'company/domain/x.ts',
      'accounts/domain/x.ts',
      'x.test.ts',
      'company/domain/x.test.ts',
    ]) {
      for (const name of packages.filter((p) => !SHARED_PACKAGES.has(p))) {
        expect(violationsOf(file, `import x from '${name}';`)).toEqual([`${file} imports ${name}`]);
      }
    }
  });

  it('the checker reports a global that reaches the machine', () => {
    expect(violationsOf('accounts/domain/x.ts', 'const home = process.env.HOME;')).toEqual([
      'accounts/domain/x.ts uses process',
    ]);
    expect(
      violationsOf('company/application/x.ts', "await fetch('https://sprocket.test');"),
    ).toEqual(['company/application/x.ts uses fetch']);
  });

  // One case for each global the inner layers refuse.
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
    for (const file of [
      'shared/x.ts',
      'accounts/domain/x.ts',
      'accounts/application/x.ts',
      'company/domain/x.ts',
      'company/application/x.ts',
    ]) {
      expect(violationsOf(file, source)).toEqual([`${file} uses ${name}`]);
    }
  });

  it('the checker reads a global reached through globalThis as that global', () => {
    expect(violationsOf('company/domain/x.ts', "void globalThis.fetch('/');")).toEqual([
      'company/domain/x.ts uses globalThis',
      'company/domain/x.ts uses fetch',
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
    expect(violationsOf('accounts/domain/x.ts', source)).toEqual([]);
  });

  it('the checker lets adapters, the ring and tests reach the machine', () => {
    expect(
      violationsOf('company/adapters/persistence/x.ts', 'const a = process.env.HOME;'),
    ).toEqual([]);
    expect(violationsOf('main.ts', 'process.exit(1);')).toEqual([]);
    expect(violationsOf('company/domain/x.test.ts', "process.env.X = '1';")).toEqual([]);
  });

  it('the checker refuses a file in no layer, and an import it cannot read', () => {
    expect(violationsOf('company/adapters/x.ts', '')).toEqual([
      'company/adapters/x.ts is in no layer',
    ]);
    expect(violationsOf('accounts/x.ts', '')).toEqual(['accounts/x.ts is in no layer']);
    expect(violationsOf('compose.ts', 'const loaded = await import(name);')).toEqual([
      `compose.ts imports ${NON_LITERAL}`,
    ]);
  });
});
