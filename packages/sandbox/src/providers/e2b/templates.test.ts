import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { e2bTemplateFrom } from './templates';

const TEMPLATES = join(__dirname, '..', '..', '..', 'templates');

/**
 * Every template is read as E2B reads it, with no network: a Dockerfile E2B would refuse, or
 * build only in part (it warns and skips an instruction it does not know), fails here rather
 * than on Consola's account.
 */
describe('the templates', () => {
  const names = readdirSync(TEMPLATES);

  it('are there', () => {
    expect(names).toContain('consola-base');
  });

  it.each(names)('%s reads as a Dockerfile E2B builds whole', (name) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => e2bTemplateFrom(join(TEMPLATES, name))).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // e2bdev/base has Node 20.9.0 (npm 10, corepack, yarn) in /usr/local, which the default PATH
  // finds before /usr/bin: a Node installed anywhere else would not be the one `node` runs, and
  // one unpacked over it leaves npm 10's files among the new npm's, which then fails to start.
  it.each(names)("%s removes E2B's base image's Node before it installs its own", (name) => {
    const dockerfile = readFileSync(join(TEMPLATES, name, 'Dockerfile'), 'utf8');
    const install = dockerfile.search(/deb\.nodesource\.com|nodejs\.org\/dist/);
    if (!/^FROM e2bdev\/base\b/m.test(dockerfile) || install === -1) return;
    const removal = /^RUN rm -rf \/usr\/local\/lib\/node_modules[^\n]*(?:\n [^\n]*)*/m.exec(
      dockerfile,
    );
    expect(removal?.[0]).toMatch(/\/usr\/local\/bin\/node\b/);
    expect(removal?.[0]).toMatch(/\/usr\/local\/bin\/npm\b/);
    expect(removal?.index ?? Number.POSITIVE_INFINITY).toBeLessThan(install);
  });
});
