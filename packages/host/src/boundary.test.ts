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
/**
 * t3's test kits: `@t3tools/provider-testing`, any package's `testing` entry
 * (`@t3tools/provider-claude/testing`), Codex's app-server replay
 * (`effect-codex-app-server/replay`), and any `testkit` module of the lifted server
 * (`t3/orchestration-v2/testkit/…`, `….testkit.ts`). Replays and fakes are for tests only.
 */
const TEST_KITS = 'test-kits';

type Layer = {
  /** A folder under `src/`, or a file there without its extension. */
  at: string;
  /** The layers its relative imports may reach. */
  reaches: string[];
  /** Packages it may not import: a name, a scope (`@scope/*`), `node:*` or `*`. */
  refuses: string[];
  /** Globals it may not refer to. */
  noGlobals: string[];
  /**
   * The Consola packages it may import, each by its exact name (never a path inside it), though
   * `NEVER` refuses every other: the contracts the host speaks and the interface it runs sandboxes
   * through. A test file takes the list of the module it sits beside (`adapters/x.test.ts`,
   * `adapters`'s).
   */
  consola: string[];
  /**
   * Whether it may use a test seam (a name ending in `ForTests`) as tests do: only for a ring
   * that nothing but tests reaches, so a seam it uses still never reaches the host's own code.
   */
  testSeams?: true;
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

/**
 * What a runner and its cell say to each other (MIT). It does no I/O, so every ring may name it.
 */
const RUNNER_PROTOCOL = '@consola/runner-protocol';
/** The sandbox interface (`sandboxesFrom`) and its fake: the outer rings run sandboxes with it. */
const SANDBOX = '@consola/sandbox';
/**
 * The E2B provider, an entry point of its own so nothing else loads E2B's SDK: only the wiring
 * builds it, from the runner's key (`productionProvider`), and loads it only then (a dynamic
 * `import()`), so a session's host, which runs the same file, never loads E2B's SDK.
 */
const SANDBOX_E2B = '@consola/sandbox/e2b';
/**
 * The factory files' schema (MIT), for a step's declared outputs and documents: its types and its
 * pure checks (`OutputType`, `checkOutputs`, `ARTIFACT_NAME_PATTERN`). It does no I/O, so `core`
 * may name it, and so may the rings that run steps.
 */
const FACTORY_SPEC = '@consola/factory-spec';

const LAYERS: Layer[] = [
  {
    // Pure decisions. The vendored contracts are types and schemas, so they may be named
    // (`ModelSelection`); nothing that reaches the machine or the network.
    at: 'core',
    reaches: ['core'],
    refuses: [NODE_BUILTINS, 'effect/process', 'ws', 'jose'],
    noGlobals: MACHINE_GLOBALS,
    // The protocol's types and readers, and the factory files' output types and checks; never the
    // sandboxes: starting one is the adapters'.
    consola: [RUNNER_PROTOCOL, FACTORY_SPEC],
  },
  {
    // Effect services over the vendored packages. Free to use them and `core`, never the
    // adapters that sit outside it, and never a test kit outside a test.
    at: 'runtime',
    reaches: ['core', 'runtime'],
    refuses: [TEST_KITS],
    noGlobals: [],
    consola: [RUNNER_PROTOCOL],
  },
  {
    at: 'adapters',
    reaches: ['core', 'runtime', 'adapters'],
    refuses: [TEST_KITS],
    noGlobals: [],
    consola: [RUNNER_PROTOCOL, SANDBOX, FACTORY_SPEC],
  },
  {
    // What tests share (an isolated machine, fake CLIs, the command over a replay). No other ring
    // reaches it, so only tests import it, or start it with node; it may use the test runner,
    // t3's test kits and test seams, and run the command `bin.ts` wires.
    at: 'testing',
    reaches: ['core', 'runtime', 'testing', 'bin'],
    refuses: [],
    noGlobals: [],
    testSeams: true,
    consola: [RUNNER_PROTOCOL, SANDBOX, FACTORY_SPEC],
  },
  // The bin: signal handlers first, then the program, loaded from `bin.ts` alone, or the step
  // tools' server from `stepToolsMain.ts` alone. No package, so its handlers are in place before
  // anything loads.
  {
    at: 'main',
    reaches: ['bin', 'stepToolsMain'],
    refuses: [ANY_PACKAGE],
    noGlobals: [],
    consola: [],
  },
  // The step tools' MCP server, which a step's CLI starts in its sandbox: its own entry, so it
  // loads the server and its decisions and none of t3's runtime, which `bin.ts` loads.
  {
    at: 'stepToolsMain',
    reaches: ['core', 'adapters'],
    refuses: [TEST_KITS],
    noGlobals: [],
    consola: [],
  },
  // The one wiring file, where everything meets, and the one place a real provider is made.
  {
    at: 'bin',
    reaches: ['core', 'runtime', 'adapters'],
    refuses: [TEST_KITS],
    noGlobals: [],
    consola: [RUNNER_PROTOCOL, SANDBOX, SANDBOX_E2B],
  },
];

/**
 * What every file, tests included, may never import: another Consola package or an app, but the
 * ones its layer names in `consola`.
 */
const NEVER = ['@consola/*'];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const isTestFile = (file: string): boolean => /\.test\.(?:[cm]?[jt]s|tsx)$/.test(file);

/**
 * A name ending in `ForTests` is a seam only tests may use (`layerForTests`). A module may declare
 * one, and one seam may be built from another inside its own body: a seam that is a function,
 * so that code runs only when a test calls it, never as the module loads. Anywhere else, a file
 * that is not a test may not refer to one: not call it, not reach it through a namespace, not
 * import it under another name. A plain import is judged by those uses.
 */
const TEST_ONLY_NAME = /ForTests$/;

const isTestOnlyName = (name: ts.Node | undefined): boolean =>
  name !== undefined && ts.isIdentifier(name) && TEST_ONLY_NAME.test(name.text);

/**
 * Whether `node` sits in the body of a seam that is a function: `function xForTests() {…}`, or
 * `const xForTests = (…) => …` / `= function (…) {…}`.
 */
function insideSeam(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && isTestOnlyName(current.name)) return true;
    if (
      ts.isVariableDeclaration(current) &&
      isTestOnlyName(current.name) &&
      current.initializer === child &&
      (ts.isArrowFunction(child) || ts.isFunctionExpression(child))
    ) {
      return true;
    }
    child = current;
  }
  return false;
}

/** Every use of a test-only name in `source` that is not a seam's own definition. */
function testOnlyReferencesOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && TEST_ONLY_NAME.test(node.text)) {
      const parent = node.parent;
      const declared =
        (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) &&
        parent.name === node;
      const imported = ts.isImportSpecifier(parent);
      const renamed =
        imported && parent.propertyName === node && !TEST_ONLY_NAME.test(parent.name.text);
      if (renamed || (!declared && !imported && !insideSeam(node))) found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

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

/**
 * The module specifiers a source file loads as it loads: each `import` and `export … from` but one
 * of types alone (`import type`, `export type`), which compiling drops. A dynamic `import()` loads
 * only once it runs, and a `require()` (which the host's ESM does not use) is not looked for.
 */
function loadedWithModuleOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  return tree.statements.flatMap((statement) => {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) return [];
      return ts.isStringLiteralLike(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [NON_LITERAL];
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      if (statement.isTypeOnly) return [];
      return ts.isStringLiteralLike(statement.moduleSpecifier)
        ? [statement.moduleSpecifier.text]
        : [NON_LITERAL];
    }
    return [];
  });
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
  if (pattern === TEST_KITS) {
    return (
      packageName(specifier) === '@t3tools/provider-testing' ||
      specifier === 'effect-codex-app-server/replay' ||
      specifier.startsWith('effect-codex-app-server/replay/') ||
      /\/testing$/.test(specifier) ||
      /(^|\/)testkit\//.test(specifier) ||
      /\.testkit\.ts$/.test(specifier)
    );
  }
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
 * The Consola packages `file` may import: its layer's, or, for a test, the layer of the module it
 * sits beside (`bin.test.ts` is `bin`'s; `boundary.test.ts` beside no module takes none).
 */
function consolaAllowedIn(file: string): string[] {
  const module = file.replace(SOURCE_EXTENSION, '').replace(/\.test$/, '');
  return layerOf(module)?.consola ?? [];
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
    if (
      NEVER.some((pattern) => matches(pattern, specifier)) &&
      !consolaAllowedIn(file).includes(specifier)
    ) {
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
  const seams = test || own?.testSeams ? [] : [...new Set(testOnlyReferencesOf(source, file))];
  return [
    ...imports,
    ...globals.map((name) => `${file} uses ${name}`),
    ...seams.map((name) => `${file} uses ${name}`),
  ];
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
    ['runtime/x.ts', '@t3tools/provider-claude/server', true],
    ['runtime/x.ts', 't3/orchestration-v2/Orchestrator.ts', true],
    ['runtime/x.ts', 'node:path', true],
    ['runtime/x.ts', './drivers.ts', true],
    ['runtime/x.ts', '@t3tools/provider-testing/replayWorkspace', false],
    ['runtime/x.ts', '@t3tools/provider-claude/testing', false],
    ['runtime/x.ts', '@t3tools/server-orchestration/testing', false],
    ['runtime/x.ts', 't3/orchestration-v2/testkit/ProviderReplayHarness.ts', false],
    ['runtime/x.ts', 't3/mcp/McpSessionRegistry.testkit.ts', false],
    ['runtime/x.ts', 'effect-codex-app-server/replay', false],
    ['adapters/x.ts', 'effect-codex-app-server/replay', false],
    ['runtime/x.ts', 'effect-codex-app-server', true],
    ['runtime/x.test.ts', 'effect-codex-app-server/replay', true],
    ['runtime/x.test.ts', '@t3tools/provider-claude/testing', true],
    ['adapters/x.ts', '@t3tools/provider-claude/testing', false],
    ['bin.ts', '@t3tools/provider-testing/replayGate', false],
    ['runtime/x.ts', '../testing/machine.ts', false],
    ['adapters/x.ts', '../testing/machine.ts', false],
    ['bin.ts', './testing/machine.ts', false],
    ['testing/x.ts', '@t3tools/provider-claude/testing', true],
    ['testing/x.ts', 'vite-plus/test', true],
    ['testing/x.ts', '../adapters/ws.ts', false],
    ['testing/x.ts', '../bin.ts', true],
    ['runtime/x.test.ts', '../testing/machine.ts', true],
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
    ['main.ts', './bin.ts', true],
    ['main.ts', './stepToolsMain.ts', true],
    ['main.ts', './core/pass.ts', false],
    ['main.ts', './adapters/ws.ts', false],
    ['stepToolsMain.ts', './adapters/stepToolsServer.ts', true],
    ['stepToolsMain.ts', './core/steps/stepTools.ts', true],
    ['stepToolsMain.ts', './runtime/threadRuntime.ts', false],
    ['stepToolsMain.ts', './bin.ts', false],
    ['stepToolsMain.ts', '@consola/sandbox', false],
    ['stepToolsMain.ts', '@t3tools/provider-claude/testing', false],
    // The factory files' schema: its output types and checks, in `core` and the rings that run
    // steps, never `runtime`, the wiring or a test beside no module.
    ['core/x.ts', '@consola/factory-spec', true],
    ['adapters/x.ts', '@consola/factory-spec', true],
    ['testing/x.ts', '@consola/factory-spec', true],
    ['core/x.test.ts', '@consola/factory-spec', true],
    ['runtime/x.ts', '@consola/factory-spec', false],
    ['main.ts', '@consola/factory-spec', false],
    ['core/x.ts', '@consola/factory-spec/dist/index.js', false],
    ['main.ts', 'effect', false],
    ['main.ts', 'node:process', false],
    ['main.ts', '@consola/runner-protocol', false],
    ['adapters/x.ts', '@consola/automation-engine', false],
    ['core/x.test.ts', '../adapters/ws.ts', true],
    ['x.test.ts', '@consola/factory-spec', false],
    // The two Consola packages the host builds on: the runner protocol in every ring, the
    // sandbox interface outside `core` and `runtime`, each by its own name only.
    ['core/x.ts', '@consola/runner-protocol', true],
    ['runtime/x.ts', '@consola/runner-protocol', true],
    ['adapters/x.ts', '@consola/runner-protocol', true],
    ['testing/x.ts', '@consola/runner-protocol', true],
    ['bin.ts', '@consola/runner-protocol', true],
    ['adapters/x.ts', '@consola/sandbox', true],
    ['testing/x.ts', '@consola/sandbox', true],
    ['bin.ts', '@consola/sandbox', true],
    ['core/x.ts', '@consola/sandbox', false],
    ['runtime/x.ts', '@consola/sandbox', false],
    ['core/x.test.ts', '@consola/runner-protocol', true],
    ['adapters/x.test.ts', '@consola/sandbox', true],
    ['bin.test.ts', '@consola/sandbox', true],
    ['core/x.test.ts', '@consola/sandbox', false],
    ['x.test.ts', '@consola/runner-protocol', false],
    // E2B's provider is made in the wiring alone.
    ['bin.ts', '@consola/sandbox/e2b', true],
    ['bin.test.ts', '@consola/sandbox/e2b', true],
    ['core/x.ts', '@consola/sandbox/e2b', false],
    ['runtime/x.ts', '@consola/sandbox/e2b', false],
    ['adapters/x.ts', '@consola/sandbox/e2b', false],
    ['testing/x.ts', '@consola/sandbox/e2b', false],
    ['adapters/x.test.ts', '@consola/sandbox/e2b', false],
    ['main.ts', '@consola/sandbox/e2b', false],
    ...[
      'core/x.ts',
      'runtime/x.ts',
      'adapters/x.ts',
      'testing/x.ts',
      'bin.ts',
      'bin.test.ts',
    ].flatMap((file) =>
      ['@consola/agent-ui', '@consola/cloud-contract', '@consola/sandbox/dist/index.js'].map(
        (specifier): [string, string, boolean] => [file, specifier, false],
      ),
    ),
    ['adapters/x.ts', '@consola/runner-protocol/dist/index.js', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  it.each([
    [
      'a call',
      "import { layerForTests } from './runtime/threadRuntime.ts';\nlayerForTests({}, {});",
    ],
    [
      'a namespace member',
      "import * as T from './runtime/threadRuntime.ts';\nT.layerForTests({}, {});",
    ],
    ['a renamed import', "import { layerForTests as layer } from './runtime/threadRuntime.ts';"],
  ])('the checker refuses a test-only seam outside tests: %s', (_spelling, source) => {
    expect(violationsOf('bin.ts', source)).toContain('bin.ts uses layerForTests');
  });

  it('only the testing ring, which only tests reach, may use a seam outside a test', () => {
    const source =
      "import { layerForTests } from '../runtime/threadRuntime.ts';\nlayerForTests({}, {});";
    expect(violationsOf('testing/x.ts', source)).toEqual([]);
    expect(violationsOf('adapters/x.ts', source)).toContain('adapters/x.ts uses layerForTests');
    expect(violationsOf('runtime/x.ts', source)).toContain('runtime/x.ts uses layerForTests');
  });

  it('a module may declare a test-only seam, build one from another, and a test may use it', () => {
    expect(violationsOf('runtime/x.ts', 'export const layerForTests = () => 1;')).toEqual([]);
    expect(
      violationsOf(
        'runtime/x.ts',
        "import { innerForTests } from './y.ts';\nexport const layerForTests = () => innerForTests();",
      ),
    ).toEqual([]);
    expect(
      violationsOf(
        'runtime/x.ts',
        "import { innerForTests } from './y.ts';\nexport const layer = () => innerForTests();",
      ),
    ).toEqual(['runtime/x.ts uses innerForTests']);
    // A seam that is not a function would run its body as the module loads, test or not.
    expect(
      violationsOf(
        'runtime/x.ts',
        "import { innerForTests } from './y.ts';\nexport const layerForTests = innerForTests();",
      ),
    ).toEqual(['runtime/x.ts uses innerForTests']);
    expect(
      violationsOf(
        'runtime/x.ts',
        "import { innerForTests } from './y.ts';\nexport function layerForTests() {\n  return innerForTests();\n}",
      ),
    ).toEqual([]);
    expect(
      violationsOf(
        'runtime/x.test.ts',
        "import { layerForTests } from './x.ts';\nlayerForTests();",
      ),
    ).toEqual([]);
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

  it("bin.ts loads E2B's provider only when a runner asks for it, so a session's host never loads E2B's SDK", () => {
    const bin = readFileSync(join(SRC, 'bin.ts'), 'utf8');
    expect(importsOf(bin, 'bin.ts')).toContain(SANDBOX_E2B);
    expect(loadedWithModuleOf(bin, 'bin.ts')).not.toContain(SANDBOX_E2B);
  });

  it('the checker tells what loads with a module from what loads once it runs', () => {
    expect(loadedWithModuleOf(`import { E2BProvider } from '${SANDBOX_E2B}';`)).toEqual([
      SANDBOX_E2B,
    ]);
    expect(loadedWithModuleOf(`export { E2BProvider } from '${SANDBOX_E2B}';`)).toEqual([
      SANDBOX_E2B,
    ]);
    expect(loadedWithModuleOf(`import '${SANDBOX_E2B}';`)).toEqual([SANDBOX_E2B]);
    expect(loadedWithModuleOf(`import type { E2BProvider } from '${SANDBOX_E2B}';`)).toEqual([]);
    expect(loadedWithModuleOf(`export type { E2BProvider } from '${SANDBOX_E2B}';`)).toEqual([]);
    expect(
      loadedWithModuleOf(`const load = async () => (await import('${SANDBOX_E2B}')).E2BProvider;`),
    ).toEqual([]);
  });
});
