// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the built file.
/**
 * CI's check of `dist/THIRD-PARTY-NOTICES` (`bundleGuards.ts` writes it): it exists, names
 * every package with a licence, has no unknown one, and holds the full text for each licence that
 * needs it, including `heic-to` (LGPL-3.0) and `@betteroffice/fonts` (OFL).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENTRY_MARK, needsFullText } from './bundleGuards.ts';

/** What is wrong with a notices file, one sentence each; empty when it is whole. */
export const problemsIn = (notices: string): string[] => {
  const problems: string[] = [];
  const entries = notices.split(ENTRY_MARK).slice(1);
  if (entries.length === 0) return ['It lists no package.'];
  const seen = new Set<string>();
  for (const entry of entries) {
    const [name = '', licenseLine = '', ...rest] = entry.split('\n');
    seen.add(name.replace(/@[^@]*$/, ''));
    const license = licenseLine.replace(/^License: /, '');
    if (!licenseLine.startsWith('License: ') || /^(unknown|unlicensed|none)/i.test(license)) {
      problems.push(`${name} has no known licence.`);
    } else if (needsFullText(license) && rest.join('\n').trim().length < 200) {
      problems.push(`${name} is ${license} and its entry has no licence text.`);
    }
  }
  for (const required of ['heic-to', '@betteroffice/fonts']) {
    if (!seen.has(required)) problems.push(`${required} is bundled but not listed.`);
  }
  const text = notices;
  if (!/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) problems.push('No LGPL text is included.');
  if (!/SIL OPEN FONT LICENSE/i.test(text)) problems.push('No OFL text is included.');
  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../dist/THIRD-PARTY-NOTICES', import.meta.url));
  let notices: string;
  try {
    notices = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`No ${file}: build the package first.\n`);
    process.exit(1);
  }
  const problems = problemsIn(notices);
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write(
    'notices: every bundled package is listed, with the text its licence needs.\n',
  );
}
