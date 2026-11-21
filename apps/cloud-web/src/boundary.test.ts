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
  /** Names it may not use at all, whatever they refer to: the browser's I/O. */
  noNames: string[];
};

const ENTRY = ['main', 'env.d'];

const LAYERS: Layer[] = [
  {
    at: 'domain',
    reaches: ['domain'],
    refuses: [ANY_PACKAGE],
    noNames: ['window', 'document', 'fetch', 'history', 'localStorage'],
  },
  {
    // `better-auth/react` is allowed here: it is the auth client, not React.
    at: 'services',
    reaches: ['domain', 'services'],
    refuses: ['react', 'react-dom', '@radix-ui/*', NODE_BUILTINS],
    noNames: [],
  },
  {
    at: 'ui',
    reaches: ['domain', 'services', 'ui'],
    refuses: ['better-auth', '@better-auth/*', NODE_BUILTINS],
    noNames: ['fetch', 'history', 'location'],
  },
  // The entry, where everything meets.
  ...ENTRY.map((at) => ({
    at,
    reaches: ['domain', 'services', 'ui', ...ENTRY],
    refuses: [],
    noNames: [],
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

/** Every identifier a source file spells, so `window.location` yields `window` and `location`. */
function identifiersOf(source: string, fileName = 'x.ts'): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) names.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names;
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
  const names =
    test || !own
      ? []
      : [...new Set(identifiersOf(source, file).filter((name) => own.noNames.includes(name)))].map(
          (name) => `${file} uses ${name}`,
        );
  return [...imports, ...names];
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

  // One case for each name a layer refuses.
  it.each([
    ['domain/x.ts', 'window', 'const here = window;'],
    ['domain/x.ts', 'document', 'const here = document;'],
    ['domain/x.ts', 'fetch', "void fetch('/');"],
    ['domain/x.ts', 'history', 'const here = history;'],
    ['domain/x.ts', 'localStorage', 'const here = localStorage;'],
    ['ui/x.tsx', 'fetch', "void fetch('/');"],
    ['ui/x.tsx', 'history', 'window.history.replaceState(null, "", "/");'],
    ['ui/x.tsx', 'location', 'window.location.reload();'],
  ])('%s using %s is reported', (file, name, source) => {
    expect(violationsOf(file, source)).toEqual([`${file} uses ${name}`]);
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
