import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE RENDERER MUST NEVER DERIVE ATTENTION. Do not delete this test.
 *
 * Status was once derived twice, in main and in the renderer, from different
 * inputs, and the two drifted: one said "working" while the other said done.
 * Attention is derived once, in `src/main/attention/`, and the renderer only
 * reads it (types and ranking live in `src/shared/attention.ts`).
 *
 * This scan is the mechanism, not tsconfig: `include` picks root files only,
 * and TypeScript follows an import anywhere, which is how the renderer reaches
 * `src/shared` today. There is no ESLint to lean on either. Tests are exempt:
 * `restoreScreen.test.ts` imports `main/ScreenModel` and has to keep working.
 */
const SRC = path.resolve(__dirname, '../..');
const RENDERER = path.join(SRC, 'renderer');
const FORBIDDEN = path.join(SRC, 'main', 'attention');

const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(SPECIFIER)].map((match) => match[1]);
}

function reachesForbidden(file: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = path.resolve(path.dirname(file), specifier);
  return target === FORBIDDEN || target.startsWith(FORBIDDEN + path.sep);
}

describe('the renderer does not derive attention', () => {
  it('has no non-test file under src/renderer importing from src/main/attention', () => {
    const offenders = sourceFiles(RENDERER).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => reachesForbidden(file, specifier))
        .map((specifier) => `${path.relative(SRC, file)} imports '${specifier}'`)
    );
    expect(
      offenders,
      'Attention is derived once, in main (src/main/attention). The renderer must read it ' +
        '(attention:changed, src/shared/attention.ts), never derive it, or main and the sidebar ' +
        'can disagree about a session. Offending imports:\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('would catch an offender: the scan finds a known cross-process import', () => {
    // restoreScreen.test.ts is exempt only because it is a test; its import must still be seen.
    const known = path.join(RENDERER, 'components/Terminal/restoreScreen.test.ts');
    expect(importsOf(known).some((s) => /main\/ScreenModel$/.test(s))).toBe(true);
    expect(reachesForbidden(path.join(RENDERER, 'x.ts'), '../main/attention/deriveAttention')).toBe(true);
    expect(reachesForbidden(path.join(RENDERER, 'a/b.ts'), '../../shared/attention')).toBe(false);
  });
});
