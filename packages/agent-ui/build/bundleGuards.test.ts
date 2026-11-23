// @effect-diagnostics nodeBuiltinImport:off - A build test: it writes a fixture and builds it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite-plus';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import {
  copiedNoticesFor,
  ENTRY_MARK,
  noticesFor,
  packageDirOf,
  renderNotices,
  sameTextAs,
} from './bundleGuards.ts';
import { problemsIn } from './checkNotices.ts';
import { T3_APP_VERSION } from './t3Version.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-ui-guards-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The package's own Vite config: the guard is tested where the package's build puts it. */
const PACKAGE_CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

/** A marker in every fake SDK module, so a build that let one through shows it. */
const FAKE_SDK = 'FAKE_SERVER_SDK_MODULE';

/** Writes a package into the fixture's `node_modules`, with an MIT licence and its files. */
const fixturePackage = (name: string, files: Record<string, string>) => {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: 'index.js', type: 'module', license: 'MIT' }),
  );
  writeFileSync(join(dir, 'LICENSE'), `MIT License\n\nCopyright (c) Sprocket\n`);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};

// Both SDKs are installed, so Vite's resolver finds them: a guard that runs after it is never
// asked, and the build bundles the fake (the guard's first placement, in
// `build.rolldownOptions.plugins`, did exactly that).
fixturePackage('@cursor/sdk', {
  'index.js': `export const sdk = '${FAKE_SDK}';\n`,
  'something.js': `export const sdk = '${FAKE_SDK}';\n`,
});
fixturePackage('@anthropic-ai/claude-agent-sdk', {
  'index.js': `export const sdk = '${FAKE_SDK}';\n`,
  'sdk.mjs': `export const sdk = '${FAKE_SDK}';\n`,
});
const sdkUser = fixturePackage('sdk-user', {
  'index.js': "export { sdk } from '@cursor/sdk';\n",
});

/** Builds `entry` as the package builds its library: its own config, with only the entry changed. */
const buildAsThePackage = (entry: string) =>
  build({
    configFile: PACKAGE_CONFIG,
    root,
    logLevel: 'silent',
    build: { write: false, lib: { entry } },
  });

/** Whatever a build that succeeded wrote, as text. */
const writtenText = (output: Awaited<ReturnType<typeof build>>): string =>
  (Array.isArray(output) ? output : [output])
    .flatMap((result) => ('output' in result ? result.output : []))
    .map((file) =>
      'code' in file ? file.code : typeof file.source === 'string' ? file.source : '',
    )
    .join('\n');

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Fails unless the build is refused for `importer`'s import of `source`. */
const refusedNaming = async (entry: string, importer: string, source: string) => {
  let output: Awaited<ReturnType<typeof build>>;
  try {
    output = await buildAsThePackage(entry);
  } catch (error) {
    expect(String(error instanceof Error ? error.message : error)).toMatch(
      new RegExp(`${escaped(importer)} imports ${escaped(source)}`),
    );
    return;
  }
  throw new Error(
    `the build of ${entry} succeeded; the bundle ${
      writtenText(output).includes(FAKE_SDK) ? 'holds' : 'does not hold'
    } the fake ${source}`,
  );
};

/** Builds through the whole package config, several times over on a loaded machine. */
const BUILD_TIMEOUT = 120_000;

describe('serverSdkGuard, in the package build', () => {
  for (const source of [
    '@cursor/sdk',
    '@cursor/sdk/something',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ]) {
    it(`fails a build whose file imports ${source}, naming the file`, {
      timeout: BUILD_TIMEOUT,
    }, async () => {
      const entry = join(root, `import-${source.replace(/\W/g, '-')}.ts`);
      writeFileSync(entry, `import * as sdk from '${source}';\nexport default sdk;\n`);
      await refusedNaming(entry, entry, source);
    });
  }

  it('fails a build whose dependency imports the SDK, naming the dependency', {
    timeout: BUILD_TIMEOUT,
  }, async () => {
    const entry = join(root, 'via-dependency.ts');
    writeFileSync(entry, "export { sdk } from 'sdk-user';\n");
    await refusedNaming(entry, join(sdkUser, 'index.js'), '@cursor/sdk');
  });

  it('fails a build whose file imports the SDK dynamically', {
    timeout: BUILD_TIMEOUT,
  }, async () => {
    const entry = join(root, 'dynamic.ts');
    writeFileSync(entry, "export const load = () => import('@anthropic-ai/claude-agent-sdk');\n");
    await refusedNaming(entry, entry, '@anthropic-ai/claude-agent-sdk');
  });

  it('fails a build whose worker imports the SDK, naming the worker', {
    timeout: BUILD_TIMEOUT,
  }, async () => {
    const worker = join(root, 'sdk.worker.ts');
    writeFileSync(worker, "import { sdk } from '@cursor/sdk';\nself.postMessage(sdk);\n");
    const entry = join(root, 'with-worker.ts');
    writeFileSync(
      entry,
      "export const start = () => new Worker(new URL('./sdk.worker.ts', import.meta.url), { type: 'module' });\n",
    );
    await refusedNaming(entry, worker, '@cursor/sdk');
  });

  it('lets a build with no such import through', { timeout: BUILD_TIMEOUT }, async () => {
    const entry = join(root, 'fine.ts');
    writeFileSync(entry, "export const fine = '@cursor/sdk-is-only-text';\n");
    expect(writtenText(await buildAsThePackage(entry))).toContain('@cursor/sdk-is-only-text');
  });
});

describe('third-party notices', () => {
  const dependency = (name: string, files: Record<string, string>) => {
    const dir = join(root, 'proj', 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), text);
    }
    return dir;
  };
  const manifest = (name: string, license?: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      name,
      version: '1.2.3',
      ...(license === undefined ? {} : { license }),
      ...extra,
    });

  /** t3code's packages, copied into `vendor/t3code`, and t3's own notice there. */
  const T3_TREE = fileURLToPath(new URL('../../../vendor/t3code/', import.meta.url));
  const T3_LICENSE = readFileSync(join(T3_TREE, 'LICENSE'), 'utf8').trim();
  /** This package's own sources, where t3's web app is copied (`src/t3/`). */
  const OWN_SOURCES = fileURLToPath(new URL('../src/', import.meta.url));

  it('finds the package a module belongs to, scoped, pnpm-nested and copied from t3code', () => {
    expect(packageDirOf('/a/node_modules/.pnpm/x@1/node_modules/@s/pkg/dist/i.js?v=1')).toBe(
      '/a/node_modules/.pnpm/x@1/node_modules/@s/pkg',
    );
    expect(packageDirOf('/a/node_modules/pkg/index.js')).toBe('/a/node_modules/pkg');
    expect(packageDirOf('/r/vendor/t3code/packages/contracts/src/index.ts')).toBe(
      '/r/vendor/t3code/packages/contracts',
    );
    expect(packageDirOf('/r/vendor/t3code/packages/shared/node_modules/effect/dist/index.js')).toBe(
      '/r/vendor/t3code/packages/shared/node_modules/effect',
    );
    expect(packageDirOf('/a/src/own.ts')).toBeNull();
    expect(packageDirOf('\0virtual')).toBeNull();
  });

  /** A licence's terms, long enough to be one (`MIN_LICENSE_TEXT`). */
  const terms = 'Permission is hereby granted, free of charge. '.repeat(6);

  it("carries every package's own licence text, permissive or not", () => {
    const mitText = `MIT License\n\nCopyright (c) 2020 Acme\n\n${terms}`;
    const lgplText = `GNU LESSER GENERAL PUBLIC LICENSE\n\n${terms}`;
    const mit = dependency('mit-pkg', {
      'package.json': manifest('mit-pkg', 'MIT'),
      LICENSE: mitText,
    });
    const lgpl = dependency('lgpl-pkg', {
      'package.json': manifest('lgpl-pkg', 'LGPL-3.0'),
      'COPYING.LESSER': lgplText,
    });
    const notices = noticesFor([mit, lgpl]);
    expect(notices.map((n) => [n.name, n.license, n.text])).toEqual([
      ['lgpl-pkg', 'LGPL-3.0', lgplText.trim()],
      ['mit-pkg', 'MIT', mitText.trim()],
    ]);
    expect(renderNotices(notices)).toContain('Copyright (c) 2020 Acme');
  });

  it('fails on a licence file too short to be a licence', () => {
    const pointer = dependency('pointer-pkg', {
      'package.json': manifest('pointer-pkg', 'MIT'),
      LICENSE: 'MIT, see the readme.',
    });
    expect(() => noticesFor([pointer])).toThrow(
      /pointer-pkg@1.2.3's licence text is 20 characters, too short to be one/,
    );
  });

  it("falls back to the licence's SPDX text, with the copyright its readme or author names", () => {
    const readme = dependency('readme-mit', {
      'package.json': manifest('readme-mit', 'MIT', { author: 'Someone Else' }),
      'README.md': '# readme-mit\n\n## License\n\nCopyright (c) 2010-2016 Sprocket Works\n',
    });
    const author = dependency('author-isc', {
      'package.json': manifest('author-isc', 'ISC', { author: { name: 'Acme Tools' } }),
    });
    const [isc, mit] = noticesFor([readme, author]);
    expect(mit?.text).toContain('Copyright (c) 2010-2016 Sprocket Works');
    expect(mit?.text).toContain('Permission is hereby granted, free of charge');
    expect(isc?.text).toContain('Copyright (c) Acme Tools');
    expect(isc?.text).toContain('Permission to use, copy, modify, and/or distribute');
  });

  it('fails on a package with no licence text and no SPDX text to fall back to, or no holder', () => {
    const apache = dependency('bare-apache', {
      'package.json': manifest('bare-apache', 'Apache-2.0', { author: 'Acme' }),
    });
    const anonymous = dependency('bare-mit', { 'package.json': manifest('bare-mit', 'MIT') });
    expect(() => noticesFor([apache])).toThrow(
      /bare-apache@1.2.3 is Apache-2.0, ships no licence text/,
    );
    expect(() => noticesFor([anonymous])).toThrow(
      /bare-mit@1.2.3 ships no licence text and names no copyright holder/,
    );
  });

  it("gives t3code's copied packages t3's notice and version", () => {
    const notices = noticesFor([
      join(T3_TREE, 'packages', 'client-runtime'),
      join(T3_TREE, 'packages', 'contracts'),
    ]);
    const runtime = notices.find((n) => n.name === '@t3tools/client-runtime');
    const contracts = notices.find((n) => n.name === '@t3tools/contracts');
    expect([contracts?.name, contracts?.license, contracts?.text]).toEqual([
      '@t3tools/contracts',
      'MIT',
      T3_LICENSE,
    ]);
    expect([runtime?.name, runtime?.version, runtime?.text]).toEqual([
      '@t3tools/client-runtime',
      T3_APP_VERSION,
      T3_LICENSE,
    ]);
  });

  it("lists t3's copied code and the third-party files bundled from its copy", () => {
    const notices = copiedNoticesFor([
      join(OWN_SOURCES, 't3/components/ChatView.tsx'),
      `${join(OWN_SOURCES, 't3/terminal/ghostty/vendor/ghostty-vt.wasm')}?url`,
      `${join(OWN_SOURCES, 't3/terminal/ghostty/fonts/SymbolsNerdFontMono-Regular.woff2')}?url`,
      join(OWN_SOURCES, 'AgentChat.tsx'),
    ]);
    expect(notices.map((n) => [n.name, n.license])).toEqual([
      ["Ghostty's libghostty-vt", 'MIT'],
      ['Symbols Nerd Font Mono', 'MIT'],
      ['t3code', 'MIT'],
    ]);
    const [ghostty, font, t3] = notices;
    expect(ghostty?.text).toContain('Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors');
    expect(font?.text).toContain('Copyright (c) 2014 Ryan L McIntyre');
    expect(t3?.text).toBe(T3_LICENSE);
  });

  it("fails on a file from t3's copy that is neither t3's code nor a known third-party file", () => {
    expect(() =>
      copiedNoticesFor([`${join(OWN_SOURCES, 't3/terminal/sprocket.wasm')}?url`]),
    ).toThrow(
      /t3\/terminal\/sprocket\.wasm is bundled from t3's copy, and its licence is not known/,
    );
  });

  it('fails on an unknown licence', () => {
    const none = dependency('no-license', { 'package.json': manifest('no-license') });
    expect(() => noticesFor([none])).toThrow(/no-license@1.2.3 declares no known licence/);
  });

  it("includes an OFL package's LICENSES folder", () => {
    const fonts = dependency('fonts-pkg', {
      'package.json': manifest('fonts-pkg', '(Apache-2.0 AND OFL-1.1)'),
      LICENSE: `Apache License\n\n${terms}`,
      'LICENSES/OFL-A.txt': 'SIL OPEN FONT LICENSE A',
    });
    const [notice] = noticesFor([fonts]);
    expect(notice?.text).toContain('SIL OPEN FONT LICENSE A');
  });

  it('writes a text shared by several packages once, and points the others at it', () => {
    const text = `Apache License\n${'Version 2.0 '.repeat(30)}`.trim();
    const notices = noticesFor([
      dependency('apache-a', { 'package.json': manifest('apache-a', 'Apache-2.0'), LICENSE: text }),
      dependency('apache-b', { 'package.json': manifest('apache-b', 'Apache-2.0'), LICENSE: text }),
    ]);
    const rendered = renderNotices(notices);
    expect(rendered.split(text)).toHaveLength(2);
    expect(rendered).toContain(sameTextAs('apache-a@1.2.3'));
  });
});

describe('checkNotices', () => {
  const long = 'x'.repeat(300);
  const entry = (name: string, license: string, text = '') =>
    `${ENTRY_MARK}${name}\nLicense: ${license}\n${text}\n`;
  const whole =
    entry('heic-to@1.0.0', 'LGPL-3.0', `GNU LESSER GENERAL PUBLIC LICENSE ${long}`) +
    entry(
      '@betteroffice/fonts@1.0.0',
      '(Apache-2.0 AND OFL-1.1)',
      `SIL OPEN FONT LICENSE ${long}`,
    ) +
    entry('t3code@0.1.11', 'MIT', `MIT License ${long}`) +
    entry('lru_map@0.4.1', 'MIT', `MIT License ${long}`);

  it('accepts a whole file', () => {
    expect(problemsIn(whole)).toEqual([]);
  });

  it('fails an LGPL entry without its text', () => {
    const broken = whole.replace(`GNU LESSER GENERAL PUBLIC LICENSE ${long}`, '');
    expect(problemsIn(broken)).toContain(
      'heic-to@1.0.0 is LGPL-3.0 and its entry has no licence text.',
    );
  });

  it('fails a permissive entry without its text, or with only its name', () => {
    expect(problemsIn(whole + entry('saxes@6.0.0', 'ISC'))).toContain(
      'saxes@6.0.0 is ISC and its entry has no licence text.',
    );
    expect(problemsIn(whole + entry('tiny@1.0.0', 'MIT', 'MIT'))).toContain(
      'tiny@1.0.0 is MIT and its entry has no licence text.',
    );
  });

  it('accepts an entry that points at an earlier one with the same text, and only then', () => {
    expect(problemsIn(whole + entry('same@1.0.0', 'MIT', sameTextAs('lru_map@0.4.1')))).toEqual([]);
    expect(problemsIn(whole + entry('lost@1.0.0', 'MIT', sameTextAs('nowhere@1.0.0')))).toContain(
      'lost@1.0.0 is MIT and its entry has no licence text.',
    );
  });

  it('fails an unknown licence', () => {
    expect(problemsIn(whole + entry('mystery@1.0.0', 'UNKNOWN'))).toContain(
      'mystery@1.0.0 has no known licence.',
    );
  });

  it("fails when heic-to or t3code's own notice is not listed", () => {
    expect(
      problemsIn(
        entry('@betteroffice/fonts@1.0.0', 'OFL-1.1', `SIL OPEN FONT LICENSE ${long}`) +
          entry('t3code@0.1.11', 'MIT', `MIT License ${long}`),
      ),
    ).toContain('heic-to is bundled but not listed.');
    expect(problemsIn(whole.replace(/t3code@0\.1\.11/, 'other@1.0.0'))).toContain(
      't3code is bundled but not listed.',
    );
  });
});
