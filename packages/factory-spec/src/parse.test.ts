import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';

const VALID = `
version: 1
automations:
  - name: clean-up-stale-sessions
    on: { cron: "0 9 * * *" }
    run: consola#cleanup_stale_sessions
    with: { pr_states: [merged, closed] }
    mode: auto
`;

describe('parseFactorySpec', () => {
    it('loads a valid automation with its parsed target and source line', () => {
        const result = parseFactorySpec(VALID);
        expect(result.issues).toEqual([]);
        expect(result.automations).toEqual([
            {
                name: 'clean-up-stale-sessions',
                trigger: { kind: 'cron', cron: '0 9 * * *' },
                run: {
                    kind: 'tool',
                    ref: 'consola#cleanup_stale_sessions',
                    namespace: 'consola',
                    tool: 'cleanup_stale_sessions',
                },
                with: { pr_states: ['merged', 'closed'] },
                mode: 'auto',
                line: 4,
            },
        ]);
    });

    it('defaults mode to confirm and with to {}', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "*/5 * * * *" }\n    run: consola#x\n'
        );
        expect(result.issues).toEqual([]);
        expect(result.automations[0]).toMatchObject({ mode: 'confirm', with: {} });
    });

    it('says why a workspace selector is not needed', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: consola#x\n    workspace: Acme\n'
        );
        expect(result.automations).toEqual([]);
        expect(result.issues).toMatchObject([
            { path: 'automations[0].workspace', message: expect.stringMatching(/belongs to one workspace/), line: 6 },
        ]);
    });

    it('treats an empty or comments-only file as no automations', () => {
        expect(parseFactorySpec('')).toEqual({ automations: [], issues: [] });
        expect(parseFactorySpec('# nothing yet\n')).toEqual({ automations: [], issues: [] });
    });

    it('treats an automations key with nothing under it as no automations', () => {
        // What a file looks like once its last automation is commented out.
        const text = 'version: 1\nautomations:\n  # - name: a\n  #   on: { cron: "0 9 * * *" }\n';
        expect(parseFactorySpec(text)).toEqual({ automations: [], issues: [] });
    });

    it('loads nothing and reports the line when the YAML itself is broken', () => {
        const result = parseFactorySpec('version: 1\nautomations:\n  - name: a\n   bad: [\n');
        expect(result.automations).toEqual([]);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].line).toBeGreaterThan(0);
    });

    it('requires version: 1', () => {
        const result = parseFactorySpec('automations: []\n');
        expect(result.automations).toEqual([]);
        expect(result.issues[0]).toMatchObject({ path: 'version' });
        expect(result.issues[0].message).toContain('version: 1');
    });

    it('rejects unknown top-level keys, pointing at the key', () => {
        const result = parseFactorySpec('version: 1\nautomation: []\n');
        expect(result.automations).toEqual([]);
        expect(result.issues[0]).toMatchObject({ line: 2 });
    });

    it('isolates a bad entry: its siblings still load', () => {
        const result = parseFactorySpec(`version: 1
automations:
  - name: good
    on: { cron: "0 9 * * *" }
    run: consola#cleanup_stale_sessions
  - name: bad
    on: { cron: "0 9 * * *" }
    run: consola#cleanup_stale_sessions
    mode: sometimes
`);
        expect(result.automations.map((a) => a.name)).toEqual(['good']);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
            automation: 'bad',
            path: 'automations[1].mode',
            line: 9,
        });
    });

    it('rejects a bad cron expression with the reason', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "every day" }\n    run: consola#x\n'
        );
        expect(result.automations).toEqual([]);
        expect(result.issues[0].path).toBe('automations[0].on.cron');
        expect(result.issues[0].message).toMatch(/five cron fields/);
    });

    it('rejects six-field (seconds) cron for portability', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 0 9 * * *" }\n    run: consola#x\n'
        );
        expect(result.issues[0].message).toMatch(/five cron fields/);
    });

    it('rejects triggers the local runner does not have', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { github: issues.opened }\n    run: consola#x\n'
        );
        expect(result.issues[0].message).toMatch(/exactly one trigger, `cron`/);
    });

    it('rejects actions unless the runner allows them', () => {
        const text =
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: Review\n';
        expect(parseFactorySpec(text).issues[0].message).toMatch(/Actions .* cannot be run/);
        const allowed = parseFactorySpec(text, { allowActions: true });
        expect(allowed.issues).toEqual([]);
        expect(allowed.automations[0].run).toEqual({ kind: 'action', ref: 'Review', name: 'Review' });
    });

    it('rejects malformed tool references', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: "consola#Bad-Tool"\n'
        );
        expect(result.issues[0].message).toMatch(/not a tool reference/);
    });

    it('rejects unknown keys on an entry', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: a\n    on: { cron: "0 9 * * *" }\n    run: consola#x\n    moed: auto\n'
        );
        expect(result.issues[0]).toMatchObject({ automation: 'a', line: 6 });
    });

    it('rejects names that are not kebab-case identifiers', () => {
        const result = parseFactorySpec(
            'version: 1\nautomations:\n  - name: Clean Up\n    on: { cron: "0 9 * * *" }\n    run: consola#x\n'
        );
        expect(result.issues[0].path).toBe('automations[0].name');
    });

    it('rejects duplicate names, keeping the first', () => {
        const entry = '  - name: a\n    on: { cron: "0 9 * * *" }\n    run: consola#x\n';
        const result = parseFactorySpec(`version: 1\nautomations:\n${entry}${entry}`);
        expect(result.automations).toHaveLength(1);
        expect(result.issues[0].message).toMatch(/Duplicate automation name "a"/);
        expect(result.issues[0].line).toBe(6);
    });
});
