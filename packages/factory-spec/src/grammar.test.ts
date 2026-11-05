import { describe, expect, it } from 'vitest';
import { parseFactorySpec } from './parse';

/** One entry, its fields indented under `- name: a`. */
const one = (fields: string) => parseFactorySpec(`version: 1\nautomations:\n  - name: a\n${fields}`);

const REVIEW = '    on: { github: pull_request.review_requested }\n';
const DAILY = '    on: { cron: "0 9 * * 1-5" }\n';

describe('run:', () => {
    it('runs an action', () => {
        const result = one(`${REVIEW}    run: { action: Review }\n    mode: auto\n`);
        expect(result.issues).toEqual([]);
        expect(result.automations[0]).toMatchObject({
            trigger: { kind: 'event', connection: 'github', events: ['pull_request.review_requested'], params: {} },
            run: { kind: 'action', ref: 'Review', name: 'Review' },
            mode: 'auto',
        });
    });

    it('runs a prompt written in the automation, in a scope', () => {
        const result = one(`${DAILY}    run:\n      prompt: |\n        List my open pull requests.\n    scope: api\n`);
        expect(result.issues).toEqual([]);
        expect(result.automations[0]).toMatchObject({
            trigger: { kind: 'cron', cron: '0 9 * * 1-5' },
            run: { kind: 'prompt', ref: 'prompt', prompt: 'List my open pull requests.\n' },
            scope: 'api',
        });
    });

    it('runs a tool with its arguments under run', () => {
        const result = one(`${DAILY}    run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [merged] } }\n`);
        expect(result.issues).toEqual([]);
        expect(result.automations[0].run).toEqual({
            kind: 'tool',
            ref: 'consola#cleanup_stale_sessions',
            namespace: 'consola',
            tool: 'cleanup_stale_sessions',
            with: { pr_states: ['merged'] },
        });
    });

    it('rejects the string form, showing the object form to write', () => {
        const tool = one(`${DAILY}    run: consola#cleanup_stale_sessions\n`);
        expect(tool.automations).toEqual([]);
        expect(tool.issues[0]).toMatchObject({ path: 'automations[0].run', line: 5 });
        expect(tool.issues[0].message).toContain('run: { tool: consola#cleanup_stale_sessions }');

        const action = one(`${REVIEW}    run: Review\n`);
        expect(action.issues[0].message).toContain('run: { action: Review }');
    });

    it('reports the old run-plus-with pair once, with the whole line to write', () => {
        const result = one(`${DAILY}    run: consola#cleanup_stale_sessions\n    with: { pr_states: [merged, closed] }\n`);
        expect(result.automations).toEqual([]);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({ path: 'automations[0].run', line: 5 });
        expect(result.issues[0].message).toContain(
            'run: { tool: consola#cleanup_stale_sessions, with: { pr_states: [ merged, closed ] } }'
        );
    });

    it('rejects a top-level with, saying it moved under run', () => {
        const result = one(`${DAILY}    run: { tool: consola#x }\n    with: { a: 1 }\n`);
        expect(result.automations).toEqual([]);
        expect(result.issues[0]).toMatchObject({ path: 'automations[0].with' });
        expect(result.issues[0].message).toMatch(/under `run:`/);
    });

    it('takes with only under a tool', () => {
        const result = one(`${REVIEW}    run: { action: Review, with: { a: 1 } }\n`);
        expect(result.issues[0]).toMatchObject({ path: 'automations[0].run.with', message: 'Only a tool takes `with:`.' });
    });

    it('names exactly one thing to run', () => {
        expect(one(`${REVIEW}    run: { action: Review, prompt: hi }\n`).issues[0].message).toMatch(/one thing to run/);
        expect(one(`${REVIEW}    run: {}\n`).issues[0].message).toMatch(/one of `action`, `prompt` or `tool`/);
        expect(one(`${REVIEW}    run: { agent: Review }\n`).issues[0]).toMatchObject({ path: 'automations[0].run.agent' });
    });

    it('rejects malformed tool references and empty bodies', () => {
        expect(one(`${DAILY}    run: { tool: "consola#Bad-Tool" }\n`).issues[0].message).toMatch(/not a tool reference/);
        expect(one(`${REVIEW}    run: { action: "  " }\n`).issues[0].path).toBe('automations[0].run.action');
        expect(one(`${DAILY}    run: { prompt: "" }\n    scope: api\n`).issues[0].path).toBe('automations[0].run.prompt');
    });
});

describe('on:', () => {
    it('keeps an event’s parameters, every key after the first', () => {
        const result = one('    on: { jira: issue.transitioned, to: "Ready for dev" }\n    run: { action: Plan }\n');
        expect(result.issues).toEqual([]);
        expect(result.automations[0].trigger).toEqual({
            kind: 'event',
            connection: 'jira',
            events: ['issue.transitioned'],
            params: { to: 'Ready for dev' },
        });
        // An undotted event name is still an event name.
        expect(one('    on: { slack: mention, channel: "#bugs" }\n    run: { prompt: hi }\n    scope: api\n').issues).toEqual([]);
    });

    it('takes no parameters on a cron trigger', () => {
        const result = one('    on: { cron: "0 9 * * *", tz: UTC }\n    run: { tool: consola#x }\n');
        expect(result.issues[0]).toMatchObject({ path: 'automations[0].on.tz' });
    });

    it('rejects names that are not a connection id or an event name', () => {
        expect(one('    on: { GitHub: pull_request.review_requested }\n    run: { action: Review }\n').issues[0].message).toMatch(
            /not a trigger/
        );
        expect(one('    on: { github: Pull Request }\n    run: { action: Review }\n').issues[0]).toMatchObject({
            path: 'automations[0].on.github',
        });
        expect(one('    on: {}\n    run: { action: Review }\n').issues[0].message).toMatch(/Expected a trigger/);
    });

    it('takes one event or a list of them', () => {
        expect(one('    on: { github: pull_request.review_requested }\n    run: { action: Review }\n').automations[0].trigger).toEqual({
            kind: 'event',
            connection: 'github',
            events: ['pull_request.review_requested'],
            params: {},
        });
        expect(
            one('    on: { github: [pull_request.review_requested, pull_request.assigned] }\n    run: { action: Review }\n').automations[0].trigger
        ).toMatchObject({ events: ['pull_request.review_requested', 'pull_request.assigned'] });
    });

    it('rejects an empty or repeating list', () => {
        expect(one('    on: { github: [] }\n    run: { action: Review }\n').issues[0].message).toBe('List at least one event after `github:`.');
        expect(one('    on: { github: [pull_request.assigned, pull_request.assigned] }\n    run: { action: Review }\n').issues[0].message).toBe(
            '`pull_request.assigned` is listed twice.'
        );
    });

    it('names a bad entry in the list', () => {
        expect(one('    on: { github: [pull_request.assigned, Bad Name] }\n    run: { action: Review }\n').issues[0].path).toBe(
            'automations[0].on.github'
        );
    });
});

describe('filter and scope', () => {
    it('keeps a filter on an event trigger; the connection validates its fields', () => {
        const result = one(`${REVIEW}    filter: { repos: ["acme/*"], authors_not: ["dependabot[bot]"] }\n    run: { action: Review }\n`);
        expect(result.issues).toEqual([]);
        expect(result.automations[0].filter).toEqual({ repos: ['acme/*'], authors_not: ['dependabot[bot]'] });
    });

    it('rejects a filter on a schedule', () => {
        const result = one(`${DAILY}    filter: { repos: ["acme/*"] }\n    run: { prompt: hi }\n    scope: api\n`);
        expect(result.issues.map((issue) => issue.path)).toEqual(['automations[0].filter']);
    });

    it('requires a scope for a scheduled prompt, and refuses an action on a schedule', () => {
        expect(one(`${DAILY}    run: { prompt: hi }\n`).issues[0]).toMatchObject({ path: 'automations[0].scope' });
        expect(one(`${DAILY}    run: { action: Review }\n    scope: api\n`).issues[0].message).toMatch(/schedule has no item/);
    });

    it('refuses a scope on a tool run', () => {
        expect(one(`${DAILY}    run: { tool: consola#x }\n    scope: api\n`).issues[0]).toMatchObject({
            path: 'automations[0].scope',
        });
    });
});
