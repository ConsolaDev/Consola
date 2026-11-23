// @effect-diagnostics nodeBuiltinImport:off - The test reads the package's manifest and declarations.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/**
 * `@types/react` 18.2.6 is the first to declare `React.JSX`, which `types/index.d.ts` imports by
 * name (`import type { JSX } from 'react'`): with an older one an embedder's checker fails on the
 * package's own declaration.
 */
const FIRST_WITH_REACT_JSX = '18.2.6';

describe("the published types' peers", () => {
  const manifest = JSON.parse(read('../package.json')) as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it('import JSX from react, by name', () => {
    expect(read('../types/index.d.ts')).toMatch(/^import type \{ JSX \} from 'react';$/m);
  });

  it('declare the React types that import needs as an optional peer, from the first with it', () => {
    expect(manifest.peerDependencies?.['@types/react']).toBe(`>=${FIRST_WITH_REACT_JSX}`);
    expect(manifest.peerDependenciesMeta?.['@types/react']).toEqual({ optional: true });
  });
});
