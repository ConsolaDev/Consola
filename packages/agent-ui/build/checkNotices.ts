// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the built file.
/**
 * CI's check of `dist/THIRD-PARTY-NOTICES` (`bundleGuards.ts` writes it): it exists, every entry
 * names a known licence and carries a licence text (its own, or the same text as an entry above
 * it, by name), and it lists what every build bundles: `heic-to` (LGPL-3.0) and
 * `@betteroffice/fonts` (OFL), with those licences' texts, and t3code's own notice.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENTRY_MARK, MIN_LICENSE_TEXT } from './bundleGuards.ts';

/** What an entry says instead of a text an entry above it carries (`sameTextAs`). */
const SAME_TEXT = /^\(The same licence text as for (.+), above\.\)$/;

/** An entry's name without its version or where it is from: `heic-to@1.5.2` is `heic-to`. */
const nameOf = (title: string) =>
  title.replace(/ \(.*\)$/, '').replace(/^(@?[^@\s]+)@[^@\s]+$/, '$1');

/** Bundled by every build of the chat, so listed in every notices file. */
const REQUIRED = ['heic-to', '@betteroffice/fonts', 't3code'];

/** What is wrong with a notices file, one sentence each; empty when it is whole. */
export const problemsIn = (notices: string): string[] => {
  const problems: string[] = [];
  const entries = notices.split(ENTRY_MARK).slice(1);
  if (entries.length === 0) return ['It lists no package.'];
  const seen = new Set<string>();
  const texts = new Map<string, string>();
  for (const entry of entries) {
    const [title = '', licenseLine = '', ...rest] = entry.split('\n');
    seen.add(nameOf(title));
    const license = licenseLine.replace(/^License: /, '');
    if (!licenseLine.startsWith('License: ') || /^(unknown|unlicensed|none)/i.test(license)) {
      problems.push(`${title} has no known licence.`);
      continue;
    }
    const body = rest.join('\n').trim();
    const same = SAME_TEXT.exec(body);
    const text = same === null ? body : (texts.get(same[1] ?? '') ?? '');
    if (text.length < MIN_LICENSE_TEXT) {
      problems.push(`${title} is ${license} and its entry has no licence text.`);
      continue;
    }
    texts.set(title, text);
  }
  for (const required of REQUIRED) {
    if (!seen.has(required)) problems.push(`${required} is bundled but not listed.`);
  }
  if (!/GNU LESSER GENERAL PUBLIC LICENSE/i.test(notices)) {
    problems.push('No LGPL text is included.');
  }
  if (!/SIL OPEN FONT LICENSE/i.test(notices)) problems.push('No OFL text is included.');
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
    'notices: every bundled package and copied file is listed, each with its licence text.\n',
  );
}
