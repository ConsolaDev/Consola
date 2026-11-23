// @effect-diagnostics nodeBuiltinImport:off - Build code: it reads the packages the bundle holds.
/**
 * Two checks on what the library build bundles, as Rolldown plugins:
 *
 * - `serverSdkGuard` fails the build, naming the importing file, on any import of the Cursor SDK
 *   or the Claude Agent SDK, subpaths included. Neither is redistributable (CON-21) and both are
 *   server code, so a browser bundle holding one is a mistake. It must be asked before Vite's
 *   resolver, which answers an installed package first: a top-level plugin with
 *   `enforce: 'pre'` (and in `worker.plugins`), never in `build.rolldownOptions.plugins`. CI's
 *   grep of `dist/` stays as a second check, on what the guard could not see (a string in a
 *   dependency, say).
 * - `thirdPartyNotices` writes `dist/THIRD-PARTY-NOTICES` from the modules the build actually
 *   bundled, one entry per package with its licence, and fails the build when a bundled package's
 *   licence is unknown, or is copyleft (GPL, LGPL) or a font licence (OFL) and its full text could
 *   not be found. `build/checkNotices.ts` reads the file back, for CI.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Plugin } from 'vite-plus';

const SERVER_SDK = /^(@cursor\/sdk|@anthropic-ai\/claude-agent-sdk)(\/|$)/;

/** The message of a refused import. */
export const refusedImport = (source: string, importer: string | undefined): string =>
  `${importer ?? '(an entry)'} imports ${source}. A server SDK must not reach the browser bundle ` +
  `(@consola/agent-ui AGENTS.md, "Build").`;

export const serverSdkGuard = (): Plugin => ({
  name: 'consola-agent-ui:server-sdk-guard',
  enforce: 'pre',
  resolveId(source, importer) {
    if (SERVER_SDK.test(source)) throw new Error(refusedImport(source, importer));
    return null;
  },
});

/** A licence that needs its full text with the bundle: the GPL family and the SIL font licence. */
export const needsFullText = (license: string): boolean => /GPL|OFL/i.test(license);

/** The package an absolute module id lives in, or null for the package's own and copied sources. */
export const packageDirOf = (id: string): string | null => {
  const clean = id.split('?')[0] ?? id;
  if (clean.startsWith('\0')) return null;
  const marker = `${sep}node_modules${sep}`;
  const at = clean.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = clean.slice(at + marker.length).split(sep);
  const length = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= length) return null;
  return clean.slice(0, at + marker.length) + rest.slice(0, length).join(sep);
};

export type Notice = {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** The full licence text, for a licence that needs it. */
  readonly text: string | undefined;
};

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\..*)?$/i;

/** The licence texts a package ships: its own `LICENSE*` files, and a `LICENSES/` folder. */
const licenseTexts = (dir: string): string[] => {
  const texts: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (LICENSE_FILE.test(entry)) texts.push(readFileSync(join(dir, entry), 'utf8').trim());
  }
  const folder = join(dir, 'LICENSES');
  if (existsSync(folder)) {
    for (const entry of readdirSync(folder).sort()) {
      texts.push(readFileSync(join(folder, entry), 'utf8').trim());
    }
  }
  return texts.filter((text) => text !== '');
};

const licenseOf = (manifest: { license?: unknown; licenses?: unknown }): string | undefined => {
  if (typeof manifest.license === 'string') return manifest.license;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry: { type?: unknown }) => entry.type)
      .filter((type): type is string => typeof type === 'string');
    if (types.length > 0) return `(${types.join(' OR ')})`;
  }
  return undefined;
};

/** One notice per bundled package; throws when a licence is unknown or its full text is missing. */
export const noticesFor = (packageDirs: Iterable<string>): Notice[] => {
  const problems: string[] = [];
  const notices = new Map<string, Notice>();
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      license?: unknown;
      licenses?: unknown;
    };
    const name = manifest.name ?? dir;
    const version = manifest.version ?? '0.0.0';
    const license = licenseOf(manifest);
    if (license === undefined || /^(unknown|unlicensed|see license)/i.test(license)) {
      problems.push(`${name}@${version} declares no known licence (${license ?? 'none'}).`);
      continue;
    }
    let text: string | undefined;
    if (needsFullText(license)) {
      const texts = licenseTexts(dir);
      if (texts.length === 0) {
        problems.push(`${name}@${version} is ${license} and ships no licence text to include.`);
        continue;
      }
      text = texts.join('\n\n');
    }
    notices.set(`${name}@${version}`, { name, version, license, text });
  }
  if (problems.length > 0) {
    throw new Error(`Third-party notices cannot be written:\n${problems.join('\n')}`);
  }
  return [...notices.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/** Starts each entry (kept plain text: a NUL would make the file binary to every tool). */
export const ENTRY_MARK = `${'='.repeat(72)}\n`;

export const renderNotices = (notices: ReadonlyArray<Notice>): string => {
  const header =
    'THIRD-PARTY NOTICES\n\n' +
    "@consola/agent-ui's bundle holds the packages below, each under the licence named. The " +
    "chat's own sources, and t3code's, which are copied into it, are MIT.\n";
  const entries = notices.map((notice) => {
    const lines = [
      ENTRY_MARK.trimEnd(),
      `${notice.name}@${notice.version}`,
      `License: ${notice.license}`,
    ];
    if (notice.text !== undefined) lines.push('', notice.text);
    return lines.join('\n');
  });
  return `${[header, ...entries].join('\n')}\n`;
};

/** The package folders of the modules a chunk of a bundle renders. */
const packageDirsOf = (bundle: Record<string, { type: string; modules?: object }>): string[] =>
  Object.values(bundle)
    .filter((output) => output.type === 'chunk')
    .flatMap((output) => Object.keys(output.modules ?? {}))
    .map(packageDirOf)
    .filter((dir): dir is string => dir !== null);

/**
 * `main` goes in the library build's plugins and writes the file; `workers` goes in `worker.plugins`.
 * t3's office, PDF and image workers are bundles of their own, built while the library's modules
 * load (that is where `@betteroffice/fonts` is bundled), so each tells `main` what it holds.
 */
export const thirdPartyNotices = (): { main: Plugin; workers: Plugin } => {
  const dirs = new Set<string>();
  return {
    workers: {
      name: 'consola-agent-ui:third-party-notices-workers',
      generateBundle(_options, bundle) {
        for (const dir of packageDirsOf(bundle)) dirs.add(dir);
      },
    },
    main: {
      name: 'consola-agent-ui:third-party-notices',
      generateBundle(_options, bundle) {
        for (const dir of packageDirsOf(bundle)) dirs.add(dir);
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD-PARTY-NOTICES',
          source: renderNotices(noticesFor(dirs)),
        });
      },
    },
  };
};

/**
 * The plugins of the library's worker bundles (`worker.plugins`): t3's office, PDF and image
 * workers are bundles of their own, which the main build's plugins never see, so they carry the
 * SDK guard and the notices' collector too.
 */
export const workerPlugins = (notices: { workers: Plugin }): Plugin[] => [
  serverSdkGuard(),
  notices.workers,
];
