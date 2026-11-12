import { describe, expect, it } from 'vitest';
import { parseAutomationEntry } from './entry';

const LIST_ITEM = '- name: a\n  on: { cron: "0 9 * * *" }\n  run: { tool: consola#x }\n';
const BARE = 'name: a\non: { cron: "0 9 * * *" }\nrun: { tool: consola#x }\n';

function refusal(yaml: string) {
    const result = parseAutomationEntry(yaml);
    if (result.ok) throw new Error('expected a refusal');
    return result.issues;
}

describe('parseAutomationEntry', () => {
    it('parses a list item and a bare mapping to the same automation', () => {
        const fromItem = parseAutomationEntry(LIST_ITEM);
        const fromBare = parseAutomationEntry(BARE);
        expect(fromItem.ok && fromBare.ok).toBe(true);
        if (!fromItem.ok || !fromBare.ok) return;
        expect(fromBare.automation).toEqual(fromItem.automation);
        expect(fromItem.item.startsWith('- name: ')).toBe(true);
        expect(fromBare.item.startsWith('- name: ')).toBe(true);
        expect(fromBare.item.endsWith('\n')).toBe(false);
    });

    it('refuses anything but exactly one entry', () => {
        expect(refusal(`${LIST_ITEM}${LIST_ITEM.replace('name: a', 'name: b')}`)[0].message).toMatch(/exactly one automation/);
        expect(refusal('---\n- name: a\n---\n- name: b')[0].message).toBeTruthy();
        expect(refusal('just text')[0].message).toBeTruthy();
        expect(refusal('')[0].message).toBeTruthy();
        const unknown = refusal(`${BARE}color: red\n`)[0];
        expect(unknown.path).toBe('color');
        expect(unknown.message).toBeTruthy();
        const noScope = refusal('name: a\non: { cron: "0 9 * * *" }\nrun: { prompt: "do it" }\n');
        expect(noScope.some((issue) => issue.path === 'scope')).toBe(true);
    });

    it('reports the line within the given text', () => {
        const issues = refusal('name: a\non: { cron: "0 9 * * *" }\nrun: { tool: consola#x }\nmode: sometimes\n');
        expect(issues[0].path).toBe('mode');
        expect(issues[0].line).toBe(4);
    });
});
