import { describe, expect, it } from 'vitest';
import { automationEntryText, replaceAutomationEntry } from './edit';

const FILE = `# factory.yml
version: 1
automations:
  - name: a
    on: { cron: "0 9 * * *" }
    run: { tool: consola#x }
  - name: b
    on: { cron: "0 10 * * *" }
    run: { tool: consola#y }
  # a note between entries
  - name: c
    on: { cron: "0 11 * * *" }
    run: { tool: consola#z }
  # - name: example
  #   on: { cron: "0 12 * * *" }
`;

const NEW_B = '- name: b\n  on: { cron: "30 10 * * *" }\n  mode: auto\n  run: { tool: consola#y }';

describe('replaceAutomationEntry', () => {
    it('replaces an entry in place, keeping comments and neighbours byte for byte', () => {
        const expected = FILE.replace(
            '  - name: b\n    on: { cron: "0 10 * * *" }\n    run: { tool: consola#y }\n',
            '  - name: b\n    on: { cron: "30 10 * * *" }\n    mode: auto\n    run: { tool: consola#y }\n'
        );
        expect(replaceAutomationEntry(FILE, 'b', NEW_B)).toBe(expected);
    });

    it('replaces the last entry and a flow-style entry', () => {
        const last = replaceAutomationEntry(FILE, 'c', '- name: c\n  on: { cron: "5 5 * * *" }\n  run: { tool: consola#z }\n');
        expect(last).toBe(FILE.replace('"0 11 * * *"', '"5 5 * * *"'));

        const flow = 'version: 1\nautomations:\n  - { name: c, on: { cron: "0 11 * * *" }, run: { tool: consola#z } }\n  # tail\n';
        const result = replaceAutomationEntry(flow, 'c', '- name: c\n  on: { cron: "1 1 * * *" }\n  run: { tool: consola#z }');
        expect(result).toBe('version: 1\nautomations:\n  - name: c\n    on: { cron: "1 1 * * *" }\n    run: { tool: consola#z }\n  # tail\n');
    });

    it('throws when the name is missing, the file does not parse, or the new entry has a different name', () => {
        expect(() => replaceAutomationEntry(FILE, 'x', NEW_B)).toThrow(/no automation named "x"/);
        expect(() => replaceAutomationEntry('automations: [\n', 'b', NEW_B)).toThrow(/does not parse/);
        expect(() => replaceAutomationEntry(FILE, 'b', NEW_B.replace('name: b', 'name: other'))).toThrow(/name/);
    });
});

describe('automationEntryText', () => {
    it('returns the entry dedented, or null', () => {
        expect(automationEntryText(FILE, 'b')).toBe('- name: b\n  on: { cron: "0 10 * * *" }\n  run: { tool: consola#y }');
        expect(automationEntryText(FILE, 'nope')).toBeNull();
    });
});
