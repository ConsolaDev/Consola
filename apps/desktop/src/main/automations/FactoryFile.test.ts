import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from '@consola/factory-spec';
import { FACTORY_TEMPLATE } from './FactoryFile';

/**
 * What an editor's "toggle comment" does to a selection that is all comments:
 * removes one level from each line. Editors differ on the space after `#` —
 * VS Code takes it, Xcode leaves it — so both are exercised.
 */
function uncommentExamples(template: string, marker: RegExp): string {
    const lines = template.split('\n');
    const start = lines.indexOf('automations:') + 1;
    return lines.map((line, index) => (index >= start ? line.replace(marker, '$1') : line)).join('\n');
}

describe('FACTORY_TEMPLATE', () => {
    it('is valid and inert as written', () => {
        expect(parseFactorySpec(FACTORY_TEMPLATE)).toEqual({ automations: [], issues: [] });
    });

    it.each([
        ['removing "# " (VS Code)', /^(\s*)# ?/],
        ['removing only "#" (Xcode)', /^(\s*)#/],
    ])('turns on its example when the whole block is uncommented by %s', (_label, marker) => {
        const result = parseFactorySpec(uncommentExamples(FACTORY_TEMPLATE, marker));
        expect(result.issues).toEqual([]);
        expect(result.automations.map((automation) => automation.name)).toEqual(['clean-up-stale-sessions']);
    });
});
