// Checks that every installed dependency, in every workspace package and
// development ones included, declares a licence Consola can ship under
// AGPL-3.0-only (AGENTS.md, Licensing). Development dependencies count too:
// the web apps bundle some of theirs.
//
// It reads each package's own `license` field, through
// `pnpm licenses list`. An expression such as `(MIT OR CC0-1.0)` passes when
// one alternative passes; `(Apache-2.0 AND MIT)` needs every part to.

import { execFileSync } from 'node:child_process';

/** SPDX identifiers compatible with AGPL-3.0-only. */
export const ALLOWED = new Set([
  // Permissive.
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
  // Weak copyleft.
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MPL-2.0',
  // Copyleft that GPL-3.0 can take in. GPL-2.0-only cannot.
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  // Not code: data (caniuse-lite) and fonts, shipped as they are.
  'CC-BY-4.0',
  'OFL-1.1',
]);

/**
 * Packages whose declared licence this check cannot read but a person has
 * reviewed, keyed by name, with why each is allowed.
 */
export const REVIEWED = {};

/** Whether an SPDX expression lets Consola ship the package. */
export function allows(expression) {
  const alternatives = expression
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+/i)
    .map((alternative) => alternative.trim());
  return alternatives.some((alternative) =>
    alternative
      .split(/\s+AND\s+/i)
      .map((id) => id.trim().replace(/\+$/, '-or-later'))
      .every((id) => ALLOWED.has(id)),
  );
}

/**
 * The packages `pnpm licenses list --json` reports whose licence is not
 * allowed, one entry per name and version.
 */
export function refusals(report) {
  const refused = [];
  for (const [license, packages] of Object.entries(report)) {
    if (allows(license)) continue;
    for (const pkg of packages) {
      if (pkg.name in REVIEWED) continue;
      refused.push({ name: pkg.name, versions: pkg.versions, license });
    }
  }
  return refused.sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const report = JSON.parse(
    execFileSync('pnpm', ['licenses', 'list', '--recursive', '--json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const count = Object.values(report).reduce((sum, packages) => sum + packages.length, 0);
  const refused = refusals(report);
  if (refused.length === 0) {
    console.log(`All ${count} dependencies declare an AGPL-3.0-compatible licence.`);
    return;
  }
  for (const { name, versions, license } of refused) {
    console.log(
      `::error title=Licence not allowed::${name}@${versions.join(', ')} is licensed ${license}`,
    );
  }
  console.log(
    [
      '',
      `${refused.length} of ${count} dependencies declare a licence Consola cannot ship under`,
      'AGPL-3.0-only. Replace them, or, if the licence is compatible and only unreadable here,',
      'add the SPDX identifier to ALLOWED or the package to REVIEWED in',
      '.github/scripts/check-licenses.mjs with the reason.',
    ].join('\n'),
  );
  process.exitCode = 1;
}

if (import.meta.main) main();
