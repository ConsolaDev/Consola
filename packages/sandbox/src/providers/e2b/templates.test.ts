import { readdirSync } from 'node:fs';
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
});
