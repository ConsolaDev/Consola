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
 *   bundled: one entry per package (t3code's copied `@t3tools/*` packages included), t3code's
 *   own for its copied code, and one for each third-party file bundled from t3's copy
 *   (`COPIED_MATERIAL`), each with its licence and its licence text. MIT, ISC and BSD require
 *   the copyright and permission notice to go with every copy, Apache-2.0 a copy of the licence,
 *   LGPL and OFL their whole text: so the text is the package's own `LICENSE`, `COPYING` or
 *   `NOTICE` files (and `LICENSES/`), t3's `LICENSE` for its packages, or, for a package that
 *   ships none, its licence's SPDX text with the copyright its readme or `author` names
 *   (`spdxTexts.ts`). The build fails on an unknown licence, a package with no text to carry, and
 *   a file from t3's copy it cannot name. `build/checkNotices.ts` reads the file back, for CI.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite-plus';
import { SPDX_TEXTS } from './spdxTexts.ts';
import { T3_APP_VERSION } from './t3Version.ts';

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

/** This package's sources (`src/`), where t3's web app is copied (`src/t3/`, `src/t3-root/`). */
const OWN_SOURCES = fileURLToPath(new URL('../src/', import.meta.url));
/** t3code's copy in the repository: its packages (`@t3tools/*`) and its `LICENSE`. */
const T3_TREE = fileURLToPath(new URL('../../../vendor/t3code/', import.meta.url));
/** A module of one of t3code's copied packages: `vendor/t3code/packages/<name>/…`. */
const VENDORED_PACKAGE = /^(.*[\\/]vendor[\\/]t3code[\\/]packages[\\/][^\\/]+)[\\/]/;

/**
 * The package an absolute module id lives in: a folder in a `node_modules`, or one of t3code's
 * packages, copied into `vendor/t3code/packages`. Null for this package's own and copied sources.
 */
export const packageDirOf = (id: string): string | null => {
  const clean = id.split('?')[0] ?? id;
  if (clean.startsWith('\0')) return null;
  const marker = `${sep}node_modules${sep}`;
  const at = clean.lastIndexOf(marker);
  if (at === -1) return VENDORED_PACKAGE.exec(clean)?.[1] ?? null;
  const rest = clean.slice(at + marker.length).split(sep);
  const length = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length <= length) return null;
  return clean.slice(0, at + marker.length) + rest.slice(0, length).join(sep);
};

export type Notice = {
  readonly name: string;
  /** The package's version; none for a file copied into t3's tree. */
  readonly version: string | undefined;
  /** Where it is from, for a file copied into t3's tree. */
  readonly about?: string;
  readonly license: string;
  /** The licence text: the copyright notice and the licence's terms, as its authors wrote them. */
  readonly text: string;
};

/** How an entry names what it is about (`checkNotices.ts` reads it back). */
export const titleOf = ({ name, version, about }: Notice): string =>
  `${version === undefined ? name : `${name}@${version}`}${about === undefined ? '' : ` (${about})`}`;

/** Below this, a file is not a licence's text but a pointer to one ("MIT, see README"). */
export const MIN_LICENSE_TEXT = 200;

/** Starts each entry (kept plain text: a NUL would make the file binary to every tool). */
export const ENTRY_MARK = `${'='.repeat(72)}\n`;

/** What an entry says instead of a text an entry above it already carries. */
export const sameTextAs = (title: string): string =>
  `(The same licence text as for ${title}, above.)`;

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i;

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

type Manifest = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  author?: unknown;
};

const licenseOf = (manifest: Manifest): string | undefined => {
  if (typeof manifest.license === 'string') return manifest.license;
  if (Array.isArray(manifest.licenses)) {
    const types = manifest.licenses
      .map((entry: { type?: unknown }) => entry.type)
      .filter((type): type is string => typeof type === 'string');
    if (types.length > 0) return `(${types.join(' OR ')})`;
  }
  return undefined;
};

/** A copyright line the package's readme starts, else one naming its `author`. */
const COPYRIGHT_LINE = /^[ \t]*Copyright[ \t]+(\(c\)|©)[ \t]+\S.*$/im;
const copyrightOf = (dir: string, manifest: Manifest): string | undefined => {
  for (const entry of readdirSync(dir).sort()) {
    if (!/^readme(\..*)?$/i.test(entry)) continue;
    const line = COPYRIGHT_LINE.exec(readFileSync(join(dir, entry), 'utf8'))?.[0];
    if (line !== undefined) return line.trim();
  }
  const { author } = manifest;
  const name =
    typeof author === 'string'
      ? author
      : typeof author === 'object' && author !== null && 'name' in author
        ? String(author.name)
        : undefined;
  return name === undefined || name.trim() === '' ? undefined : `Copyright (c) ${name.trim()}`;
};

/** t3code's own notice (`vendor/t3code/LICENSE`), which its copied packages and code carry. */
const t3Notice = () => readFileSync(join(T3_TREE, 'LICENSE'), 'utf8').trim();

/**
 * Whether a package folder is one of t3code's copied packages (`vendor/t3code/packages/<name>`),
 * under t3's notice: not a package one of them installs, which has its own.
 */
export const isCopiedT3Package = (dir: string): boolean =>
  VENDORED_PACKAGE.exec(`${dir}${sep}`)?.[1] === dir;

/** The notice of one package folder, or what keeps it from being written. */
const packageNotice = (dir: string, problems: string[]): Notice | undefined => {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  const fromT3 = isCopiedT3Package(dir);
  const name = manifest.name ?? dir;
  // t3's packages carry no version of their own but `contracts`'; t3 releases them together.
  const version = manifest.version ?? (fromT3 ? T3_APP_VERSION : '0.0.0');
  const id = `${name}@${version}`;
  const license = licenseOf(manifest);
  if (license === undefined || /^(unknown|unlicensed|see license)/i.test(license)) {
    problems.push(`${id} declares no known licence (${license ?? 'none'}).`);
    return undefined;
  }
  const texts = licenseTexts(dir);
  if (texts.length > 0) return { name, version, license, text: texts.join('\n\n') };
  if (fromT3) return { name, version, license, text: t3Notice() };
  const spdx = SPDX_TEXTS[license];
  const copyright = copyrightOf(dir, manifest);
  if (spdx === undefined) {
    problems.push(
      `${id} is ${license}, ships no licence text, and build/spdxTexts.ts has no ${license} ` +
        'text to write instead.',
    );
    return undefined;
  }
  if (copyright === undefined) {
    problems.push(
      `${id} ships no licence text and names no copyright holder (no copyright line in its ` +
        'readme, no author).',
    );
    return undefined;
  }
  const text =
    `(${name} ships no licence file: the SPDX ${license} text, with the copyright its readme or ` +
    `package.json names.)\n\n${spdx(copyright)}`;
  return { name, version, license, text };
};

/**
 * Third-party files in t3's copy (`src/t3/`) that the bundle can hold, with their notices: they
 * are not packages, so nothing else would name them. `file` is matched against the path below
 * `src/`. Ghostty's notice is its repository's `LICENSE` (github.com/ghostty-org/ghostty), which
 * t3's copy does not carry, verbatim in `build/licenses/ghostty.txt`; the font's is t3's copy of
 * it, beside the font.
 */
export const COPIED_MATERIAL: ReadonlyArray<{
  readonly file: RegExp;
  readonly name: string;
  readonly about: string;
  readonly license: string;
  readonly textFile: string;
}> = [
  {
    file: /^t3\/terminal\/ghostty\/vendor\/[^/]+\.wasm$/,
    name: "Ghostty's libghostty-vt",
    about: "t3's terminal/ghostty/vendor/*.wasm",
    license: 'MIT',
    textFile: fileURLToPath(new URL('./licenses/ghostty.txt', import.meta.url)),
  },
  {
    file: /^t3\/terminal\/ghostty\/fonts\/SymbolsNerdFontMono-Regular\.woff2$/,
    name: 'Symbols Nerd Font Mono',
    about: "t3's terminal/ghostty/fonts/",
    license: 'MIT',
    textFile: join(OWN_SOURCES, 't3', 'terminal', 'ghostty', 'fonts', 'LICENSE'),
  },
];

/** t3's own code and files in its copy: its sources, and its repository's assets. */
const T3_OWN = /^(t3|t3-root)\/.*\.(ts|tsx|js|mjs|css|json)$|^t3-root\/assets\//;

/** The notices of what a bundle holds from t3's copy: t3code's own, and its third-party files. */
const copiedNotices = (moduleIds: Iterable<string>, problems: string[]): Notice[] => {
  const notices = new Map<string, Notice>();
  for (const id of moduleIds) {
    const clean = id.split('?')[0] ?? id;
    if (clean.startsWith('\0') || !clean.startsWith(OWN_SOURCES)) continue;
    const path = relative(OWN_SOURCES, clean).split(sep).join('/');
    if (!/^t3(-root)?\//.test(path)) continue;
    const material = COPIED_MATERIAL.find(({ file }) => file.test(path));
    if (material !== undefined) {
      const { name, about, license, textFile } = material;
      const text = readFileSync(textFile, 'utf8').trim();
      notices.set(name, { name, version: undefined, about, license, text });
    } else if (T3_OWN.test(path)) {
      notices.set('t3code', {
        name: 't3code',
        version: T3_APP_VERSION,
        about: "its web app's chat view, copied into src/t3/",
        license: 'MIT',
        text: t3Notice(),
      });
    } else {
      problems.push(
        `${path} is bundled from t3's copy, and its licence is not known: add it to ` +
          'COPIED_MATERIAL (build/bundleGuards.ts) with its notice.',
      );
    }
  }
  return [...notices.values()];
};

const checked = (notices: Notice[], problems: string[]): Notice[] => {
  for (const notice of notices) {
    if (notice.text.length < MIN_LICENSE_TEXT) {
      problems.push(
        `${titleOf(notice)}'s licence text is ${notice.text.length} characters, too short to be ` +
          'one: look at what it ships by hand.',
      );
    } else if (notice.text.includes(ENTRY_MARK)) {
      problems.push(`${titleOf(notice)}'s licence text holds the notices' entry mark.`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Third-party notices cannot be written:\n${problems.join('\n')}`);
  }
  return notices.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
};

/** One notice per package folder (a folder twice, or two of one version, gives one). */
const packageNotices = (packageDirs: Iterable<string>, problems: string[]): Notice[] => {
  const notices = new Map<string, Notice>();
  for (const dir of packageDirs) {
    const notice = packageNotice(dir, problems);
    if (notice !== undefined) notices.set(titleOf(notice), notice);
  }
  return [...notices.values()];
};

/** One notice per bundled package; throws when a licence is unknown or has no text to carry. */
export const noticesFor = (packageDirs: Iterable<string>): Notice[] => {
  const problems: string[] = [];
  return checked(packageNotices(packageDirs, problems), problems);
};

/** The notices of t3's copied code and the third-party files bundled from its copy. */
export const copiedNoticesFor = (moduleIds: Iterable<string>): Notice[] => {
  const problems: string[] = [];
  return checked(copiedNotices(moduleIds, problems), problems);
};

/**
 * Packages whose code reaches the bundle only through the stylesheet, which Tailwind's compiler
 * inlines (so no module of theirs is bundled): Tailwind's preflight and theme, in
 * `dist/agent-ui.css` whenever the chat's stylesheet (`src/styles.css`) is.
 */
const STYLESHEET_PACKAGES = ['tailwindcss'];
const CHAT_STYLESHEET = join(OWN_SOURCES, 'styles.css');

/** Every notice a bundle of these modules needs. */
export const bundleNotices = (moduleIds: Iterable<string>): Notice[] => {
  const ids = [...moduleIds];
  const dirs = new Set(ids.map(packageDirOf).filter((dir): dir is string => dir !== null));
  if (ids.some((id) => (id.split('?')[0] ?? id) === CHAT_STYLESHEET)) {
    for (const name of STYLESHEET_PACKAGES) {
      dirs.add(realpathSync(join(OWN_SOURCES, '..', 'node_modules', name)));
    }
  }
  const problems: string[] = [];
  return checked([...packageNotices(dirs, problems), ...copiedNotices(ids, problems)], problems);
};

export const renderNotices = (notices: readonly Notice[]): string => {
  const header =
    'THIRD-PARTY NOTICES\n\n' +
    "@consola/agent-ui's bundle holds the code and files below, each under the licence named, " +
    'with its licence text: the copyright notice and the terms its authors ship. A text an ' +
    "entry above already carries is not repeated. The package's own sources are MIT (its " +
    'LICENSE); t3code\'s, copied into it, have their own entry ("t3code").\n';
  const written = new Map<string, string>();
  const entries = notices.map((notice) => {
    const title = titleOf(notice);
    const lines = [ENTRY_MARK.trimEnd(), title, `License: ${notice.license}`, ''];
    const first = written.get(notice.text);
    if (first === undefined) {
      written.set(notice.text, title);
      lines.push(notice.text);
    } else lines.push(sameTextAs(first));
    return lines.join('\n');
  });
  return `${[header, ...entries].join('\n')}\n`;
};

/** The module ids every chunk of a bundle renders. */
const moduleIdsOf = (bundle: Record<string, { type: string; modules?: object }>): string[] =>
  Object.values(bundle)
    .filter((output) => output.type === 'chunk')
    .flatMap((output) => Object.keys(output.modules ?? {}));

/**
 * `main` goes in the library build's plugins and writes the file; `workers` goes in `worker.plugins`.
 * t3's office, PDF and image workers are bundles of their own, built while the library's modules
 * load (that is where `@betteroffice/fonts` is bundled), so each tells `main` what it holds.
 */
export const thirdPartyNotices = (): { main: Plugin; workers: Plugin } => {
  const ids = new Set<string>();
  return {
    workers: {
      name: 'consola-agent-ui:third-party-notices-workers',
      generateBundle(_options, bundle) {
        for (const id of moduleIdsOf(bundle)) ids.add(id);
      },
    },
    main: {
      name: 'consola-agent-ui:third-party-notices',
      generateBundle(_options, bundle) {
        for (const id of moduleIdsOf(bundle)) ids.add(id);
        this.emitFile({
          type: 'asset',
          fileName: 'THIRD-PARTY-NOTICES',
          source: renderNotices(bundleNotices(ids)),
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
