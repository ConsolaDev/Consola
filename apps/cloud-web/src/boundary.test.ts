/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Keeps the dependency rule: imports point inward only. `domain` holds rules and types,
 * `services` what talks to the API and to Better Auth, and `ui` the React screens. The entry
 * (`main.tsx`, with `env.d.ts`) mounts the app and is not restricted beyond the layers it
 * reaches. Test files are exempt from the layer rules, since they wire real pieces together the
 * way the entry does.
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
  /** Globals it may not refer to: the browser's I/O. */
  noGlobals: string[];
};

const ENTRY = ['main', 'env.d'];

const LAYERS: Layer[] = [
  {
    at: 'domain',
    reaches: ['domain'],
    refuses: [ANY_PACKAGE],
    noGlobals: [
      'window',
      'document',
      'fetch',
      'history',
      'location',
      'localStorage',
      'sessionStorage',
      'navigator',
      'XMLHttpRequest',
      'WebSocket',
      'globalThis',
      'self',
    ],
  },
  {
    // `better-auth/react` is allowed here: it is the auth client, not React. The API is reached
    // only through `createApi`'s client, typed by its contract, so no service sends a request
    // of its own: one would answer in types written by hand, which nothing checks.
    at: 'services',
    reaches: ['domain', 'services'],
    refuses: ['react', 'react-dom', '@radix-ui/*', NODE_BUILTINS],
    noGlobals: ['fetch', 'XMLHttpRequest'],
  },
  {
    at: 'ui',
    reaches: ['domain', 'services', 'ui'],
    refuses: ['better-auth', '@better-auth/*', NODE_BUILTINS],
    noGlobals: [
      'fetch',
      'history',
      'location',
      'localStorage',
      'sessionStorage',
      'XMLHttpRequest',
      'WebSocket',
    ],
  },
  // The entry, where everything meets.
  ...ENTRY.map((at) => ({
    at,
    reaches: ['domain', 'services', 'ui', ...ENTRY],
    refuses: [],
    noGlobals: [],
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

/** Objects whose members are globals, so `window.location` refers to `location`. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

const isGlobalObject = (node: ts.Node): boolean =>
  ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);

/**
 * Every name a source file refers to, as a value or a type, in the order it appears. A name is
 * not a reference when it is a property's or a member's own name (`props.location`,
 * `{ location: '/' }`, a method, a type member, a JSX attribute), when it is being declared (a
 * variable, a parameter, a destructured prop, a function, a class, an import), or when it is
 * `require` called as an import, which `importsOf` judges by what it loads. A member of `window`
 * (or `globalThis`, `global`, `self`) refers to the global it names. It does not follow scopes,
 * so a local that shares a global's name is reported where it is read.
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
      found.push(node.text); // self['localStorage']
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
 * Every way one file breaks the rule, as `<file> imports <specifier>`, `<file> uses <name>` (or
 * `<file> is in no layer`). `file` is relative to `src/`; nothing is read from disk, so a test
 * can feed it any source.
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
      if (isTestFile(`${target}.ts`)) return true; // test code would be built into the app
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
    return SOURCE_EXTENSION.test(entry.name) ? [relative] : [];
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
    expect(sourceFiles().filter((file) => !isTestFile(file)).length).toBeGreaterThan(10);
  });

  it('the checker reports an outward import and a browser call', () => {
    expect(
      violationsOf(
        'domain/x.ts',
        "import { loadMe } from '../services/api';\nimport { useState } from 'react';",
      ),
    ).toEqual(['domain/x.ts imports ../services/api', 'domain/x.ts imports react']);
    expect(
      violationsOf(
        'ui/x.tsx',
        "import { createAuthClient } from 'better-auth/react';\nexport const load = () => fetch('/api/me');",
      ),
    ).toEqual(['ui/x.tsx imports better-auth/react', 'ui/x.tsx uses fetch']);
  });

  it('the checker reports a service that calls the API around its typed client', () => {
    for (const source of [
      "export const load = () => fetch('/api/teams');",
      "export const load = () => window.fetch('/api/teams');",
      "export const load = () => globalThis.fetch('/api/teams');",
      'export const request = new XMLHttpRequest();',
    ]) {
      expect(violationsOf('services/x.ts', source)).toHaveLength(1);
    }
    // Through the client, or naming `fetch` as a property, is not a call of its own.
    expect(
      violationsOf(
        'services/x.ts',
        "import createClient from 'openapi-fetch';\n" +
          'export const api = (send: (r: Request) => Promise<Response>) => createClient({ fetch: send });\n' +
          "export const load = () => api(async () => new Response()).GET('/api/me' as never);",
      ),
    ).toEqual([]);
  });

  it.each([
    ['import type', "import type { State } from 'react';"],
    ['export … from', "export { useState } from 'react';"],
    ['export * from', "export * from 'react';"],
    ['a side-effect import', "import 'react';"],
    ['dynamic import()', "const loaded = await import('react');"],
    ['typeof import()', "let loaded: typeof import('react');"],
    ['require()', "const loaded = require('react');"],
  ])('the checker reads %s', (_spelling, source) => {
    expect(violationsOf('services/x.ts', source)).toEqual(['services/x.ts imports react']);
  });

  it('the checker reads a .tsx file', () => {
    const source = "import { useState } from 'react';\nexport const view = <div />;";
    expect(violationsOf('domain/x.tsx', source)).toEqual(['domain/x.tsx imports react']);
  });

  // One case for each rule in LAYERS and NEVER, spelled as a plain import.
  it.each([
    ['domain/x.ts', './me', true],
    ['domain/x.ts', '../services/api', false],
    ['domain/x.ts', '../ui/App', false],
    ['domain/x.ts', 'node:fs', false],
    ['domain/x.ts', 'zod', false],
    ['services/x.ts', '../domain/me', true],
    ['services/x.ts', './api', true],
    ['services/x.ts', 'better-auth/react', true],
    ['services/x.ts', '../ui/App', false],
    ['services/x.ts', 'react', false],
    ['services/x.ts', 'react-dom/client', false],
    ['services/x.ts', '@radix-ui/themes', false],
    ['services/x.ts', 'node:fs', false],
    ['ui/x.tsx', '../domain/me', true],
    ['ui/x.tsx', '../services/api', true],
    ['ui/x.tsx', './Footer', true],
    ['ui/x.tsx', './styles.css', true],
    ['ui/x.tsx', 'react', true],
    ['ui/x.tsx', '@radix-ui/themes', true],
    ['ui/x.tsx', 'better-auth/react', false],
    ['ui/x.tsx', '../main', false],
    ['ui/x.tsx', 'node:fs', false],
    ['main.tsx', './ui/App', true],
    ['main.tsx', '@radix-ui/themes', true],
    ['main.tsx', '@consola/factory-spec', false],
    ['domain/x.ts', '../../../desktop/src/x', false],
    ['domain/x.ts', './y.test', false],
    ['domain/x.test.ts', '../services/api', true],
    ['x.test.ts', '../../desktop/src/x', false],
  ])('%s importing %s is allowed: %s', (file, specifier, allowed) => {
    expect(violationsOf(file, `import x from '${specifier}';`)).toEqual(
      allowed ? [] : [`${file} imports ${specifier}`],
    );
  });

  // One case for each global a layer refuses, and for each way to reach one.
  it.each([
    ['domain/x.ts', 'window', 'const here = window;'],
    ['domain/x.ts', 'document', 'const here = document;'],
    ['domain/x.ts', 'fetch', "void fetch('/');"],
    ['domain/x.ts', 'history', 'const here = history;'],
    ['domain/x.ts', 'localStorage', 'const here = localStorage;'],
    ['ui/x.tsx', 'fetch', "void fetch('/');"],
    ['ui/x.tsx', 'history', 'window.history.replaceState(null, "", "/");'],
    ['ui/x.tsx', 'location', 'window.location.reload();'],
    ['domain/x.ts', 'location', 'const here = location.href;'],
    ['domain/x.ts', 'sessionStorage', 'const here = sessionStorage;'],
    ['domain/x.ts', 'navigator', 'const here = navigator.language;'],
    ['domain/x.ts', 'XMLHttpRequest', 'const request = new XMLHttpRequest();'],
    ['domain/x.ts', 'WebSocket', "const socket = new WebSocket('ws://sprocket.test');"],
    ['domain/x.ts', 'globalThis', 'const here = globalThis;'],
    ['domain/x.ts', 'self', 'const here = self;'],
    ['ui/x.tsx', 'location', 'const here = location.pathname;'],
    ['ui/x.tsx', 'localStorage', "localStorage.setItem('a', 'b');"],
    ['ui/x.tsx', 'sessionStorage', "sessionStorage.setItem('a', 'b');"],
    ['ui/x.tsx', 'XMLHttpRequest', 'const request = new XMLHttpRequest();'],
    ['ui/x.tsx', 'WebSocket', "const socket = new WebSocket('ws://sprocket.test');"],
    ['ui/x.tsx', 'fetch', "void globalThis.fetch('/');"],
    ['ui/x.tsx', 'localStorage', "self['localStorage'].clear();"],
  ])('%s using %s is reported', (file, name, source) => {
    expect(violationsOf(file, source)).toEqual([`${file} uses ${name}`]);
  });

  it('the checker reads a global reached through window as that global', () => {
    expect(violationsOf('domain/x.ts', 'const here = window.location.href;')).toEqual([
      'domain/x.ts uses window',
      'domain/x.ts uses location',
    ]);
  });

  // Only a reference to the global counts, never a name that merely spells it.
  it.each([
    ['ui/x.tsx', 'a property read', 'const here = props.location;'],
    ['ui/x.tsx', 'an object key', "const link = { location: '/', history: [] };"],
    ['ui/x.tsx', 'a type member', 'type Props = { location: string; fetch(): void };'],
    ['ui/x.tsx', 'a destructured prop', 'function Card({ location }: Props) {}'],
    ['ui/x.tsx', 'a JSX attribute', 'const card = <Card location="/" history={[]} />;'],
    ['ui/x.tsx', 'a method', 'class Pager { history() {} }'],
    ['domain/x.ts', 'a property read', 'const here = state.location;'],
    ['domain/x.ts', 'a string or a comment', "// window.location\nconst a = 'fetch(document)';"],
  ])('%s with location as %s is not reported', (file, _name, source) => {
    expect(violationsOf(file, source)).toEqual([]);
  });

  it('the checker lets services and the entry use the browser', () => {
    expect(violationsOf('services/x.ts', 'window.location.reload();')).toEqual([]);
    expect(violationsOf('main.tsx', 'window.matchMedia("");')).toEqual([]);
  });

  it('the checker refuses a file in no layer, and an import it cannot read', () => {
    expect(violationsOf('x.ts', '')).toEqual(['x.ts is in no layer']);
    expect(violationsOf('main.tsx', 'const loaded = await import(name);')).toEqual([
      `main.tsx imports ${NON_LITERAL}`,
    ]);
  });
});
