import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The renderer and the website run in a browser, so they may take the engine's
 * types and nothing of its runtime (it imports Node modules). Type-only imports
 * and exports vanish at compile time; anything else would drag the package in.
 */

const PACKAGE = '@consola/automation-engine';
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = [
  'apps/desktop/src/renderer',
  'apps/desktop/src/shared',
  'apps/website/src',
  'apps/website/demo',
];

const isPackage = (specifier: string): boolean =>
  specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`);

/** How the source reaches the engine's runtime, one entry per offending statement; empty when type-only. */
function runtimeEngineImports(source: string): string[] {
  const tree = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isPackage(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!named &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) found.push(node.getText(tree));
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isPackage(node.moduleSpecifier.text)
    ) {
      const typeOnly =
        node.isTypeOnly ||
        (!!node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) found.push(node.getText(tree));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expression) && isPackage(expression.text) && !node.isTypeOnly)
        found.push(node.getText(tree));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      const argument = node.arguments[0];
      if (loads && argument && ts.isStringLiteralLike(argument) && isPackage(argument.text))
        found.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const files = (dir: string): string[] => {
  const absolute = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === 'dist' ? [] : files(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
};

describe('the checker', () => {
  it.each([
    ['a value import', `import { runTitle } from '${PACKAGE}';`],
    ['a default import', `import engine from '${PACKAGE}';`],
    ['a namespace import', `import * as engine from '${PACKAGE}';`],
    ['a side-effect import', `import '${PACKAGE}';`],
    ['a value re-export', `export { RunStore } from '${PACKAGE}';`],
    ['a star re-export', `export * from '${PACKAGE}';`],
    ['a subpath import', `import { a } from '${PACKAGE}/node';`],
    ['a mixed import', `import { type A, b } from '${PACKAGE}';`],
    ['a dynamic import', `const m = await import('${PACKAGE}');`],
    ['a require', `const m = require('${PACKAGE}');`],
    ['an import-equals', `import m = require('${PACKAGE}');`],
  ])('catches %s', (_name, source) => {
    expect(runtimeEngineImports(source)).toHaveLength(1);
  });

  it.each([
    ['import type', `import type { A } from '${PACKAGE}';`],
    ['a multi-line import type', `import type {\n  A,\n  B,\n} from '${PACKAGE}';`],
    ['inline type specifiers', `import { type A, type B } from '${PACKAGE}';`],
    ['export type', `export type { A } from '${PACKAGE}';`],
    ['inline type re-exports', `export { type A } from '${PACKAGE}';`],
    ['an import of something else', `import { RunStore } from './RunStore';`],
    [
      'the name in a string or comment',
      `// import { a } from '${PACKAGE}';\nconst s = "import a from '${PACKAGE}'";`,
    ],
  ])('allows %s', (_name, source) => {
    expect(runtimeEngineImports(source)).toEqual([]);
  });
});

describe('the browser-side code', () => {
  it('imports the engine for its types only', () => {
    const scanned = ROOTS.flatMap(files);
    expect(scanned.length).toBeGreaterThan(0);
    const offenders = scanned.flatMap((file) =>
      runtimeEngineImports(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')).map(
        (statement) => `${file}: ${statement}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
