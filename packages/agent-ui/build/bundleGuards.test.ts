// @effect-diagnostics nodeBuiltinImport:off - A build test: it writes a fixture and builds it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite-plus';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import {
  needsFullText,
  noticesFor,
  packageDirOf,
  renderNotices,
  serverSdkGuard,
} from './bundleGuards.ts';
import { problemsIn } from './checkNotices.ts';

const root = mkdtempSync(join(tmpdir(), 'agent-ui-guards-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Builds `entry` as a library with the guard, as the package's build does. */
const buildWithGuard = (entry: string) =>
  build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [serverSdkGuard()],
    build: {
      write: false,
      lib: { entry, formats: ['es'], fileName: 'out' },
      rolldownOptions: { external: [] },
    },
  });

describe('serverSdkGuard', () => {
  for (const source of [
    '@cursor/sdk',
    '@cursor/sdk/something',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ]) {
    it(`fails a build whose file imports ${source}, naming the file`, async () => {
      const entry = join(root, `import-${source.replace(/\W/g, '-')}.ts`);
      writeFileSync(entry, `import * as sdk from '${source}';\nexport default sdk;\n`);
      await expect(buildWithGuard(entry)).rejects.toThrow(
        new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} imports ${source}`),
      );
    });
  }

  it('lets a build with no such import through', async () => {
    const entry = join(root, 'fine.ts');
    writeFileSync(entry, "export const fine = '@cursor/sdk-is-only-text';\n");
    await expect(buildWithGuard(entry)).resolves.toBeDefined();
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
  const manifest = (name: string, license?: string) =>
    JSON.stringify({ name, version: '1.2.3', ...(license === undefined ? {} : { license }) });

  it('finds the package a module belongs to, scoped and pnpm-nested', () => {
    expect(packageDirOf('/a/node_modules/.pnpm/x@1/node_modules/@s/pkg/dist/i.js?v=1')).toBe(
      '/a/node_modules/.pnpm/x@1/node_modules/@s/pkg',
    );
    expect(packageDirOf('/a/node_modules/pkg/index.js')).toBe('/a/node_modules/pkg');
    expect(packageDirOf('/a/src/own.ts')).toBeNull();
    expect(packageDirOf('\0virtual')).toBeNull();
  });

  it('needs full text for GPL, LGPL and OFL only', () => {
    expect(['LGPL-3.0', 'GPL-3.0-only', '(Apache-2.0 AND OFL-1.1)'].map(needsFullText)).toEqual([
      true,
      true,
      true,
    ]);
    expect(['MIT', 'Apache-2.0', 'ISC'].map(needsFullText)).toEqual([false, false, false]);
  });

  it('lists a permissive package without text and an LGPL one with it', () => {
    const mit = dependency('mit-pkg', { 'package.json': manifest('mit-pkg', 'MIT') });
    const lgpl = dependency('lgpl-pkg', {
      'package.json': manifest('lgpl-pkg', 'LGPL-3.0'),
      LICENSE: 'GNU LESSER GENERAL PUBLIC LICENSE text',
    });
    const notices = noticesFor([mit, lgpl]);
    expect(notices.map((n) => [n.name, n.license, n.text])).toEqual([
      ['lgpl-pkg', 'LGPL-3.0', 'GNU LESSER GENERAL PUBLIC LICENSE text'],
      ['mit-pkg', 'MIT', undefined],
    ]);
    expect(renderNotices(notices)).toContain('GNU LESSER GENERAL PUBLIC LICENSE text');
  });

  it('fails on an unknown licence', () => {
    const none = dependency('no-license', { 'package.json': manifest('no-license') });
    expect(() => noticesFor([none])).toThrow(/no-license@1.2.3 declares no known licence/);
  });

  it('fails on an LGPL package with no licence text, and a GPL one', () => {
    const lgpl = dependency('bare-lgpl', { 'package.json': manifest('bare-lgpl', 'LGPL-3.0') });
    const gpl = dependency('bare-gpl', { 'package.json': manifest('bare-gpl', 'GPL-3.0-only') });
    expect(() => noticesFor([lgpl])).toThrow(
      /bare-lgpl@1.2.3 is LGPL-3.0 and ships no licence text/,
    );
    expect(() => noticesFor([gpl])).toThrow(/bare-gpl@1.2.3 is GPL-3.0-only/);
  });

  it("includes an OFL package's LICENSES folder", () => {
    const fonts = dependency('fonts-pkg', {
      'package.json': manifest('fonts-pkg', '(Apache-2.0 AND OFL-1.1)'),
      LICENSE: 'Apache License',
      'LICENSES/OFL-A.txt': 'SIL OPEN FONT LICENSE A',
    });
    const [notice] = noticesFor([fonts]);
    expect(notice?.text).toContain('SIL OPEN FONT LICENSE A');
  });
});

describe('checkNotices', () => {
  const long = 'x'.repeat(300);
  const entry = (name: string, license: string, text = '') =>
    `${'='.repeat(72)}\n${name}@1.0.0\nLicense: ${license}\n${text}\n`;
  const whole =
    entry('heic-to', 'LGPL-3.0', `GNU LESSER GENERAL PUBLIC LICENSE ${long}`) +
    entry('@betteroffice/fonts', '(Apache-2.0 AND OFL-1.1)', `SIL OPEN FONT LICENSE ${long}`);

  it('accepts a whole file', () => {
    expect(problemsIn(whole)).toEqual([]);
  });

  it('fails an LGPL entry without its text', () => {
    const broken = whole.replace(`GNU LESSER GENERAL PUBLIC LICENSE ${long}`, '');
    expect(problemsIn(broken)).toContain(
      'heic-to@1.0.0 is LGPL-3.0 and its entry has no licence text.',
    );
  });

  it('fails an unknown licence', () => {
    expect(problemsIn(whole + entry('mystery', 'UNKNOWN'))).toContain(
      'mystery@1.0.0 has no known licence.',
    );
  });

  it('fails when heic-to is not listed', () => {
    expect(
      problemsIn(entry('@betteroffice/fonts', 'OFL-1.1', `SIL OPEN FONT LICENSE ${long}`)),
    ).toContain('heic-to is bundled but not listed.');
  });
});
