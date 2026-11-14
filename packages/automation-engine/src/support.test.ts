import { describe, expect, it } from 'vitest';
import {
    CONSOLA_NAMESPACE,
    StartedByHandError,
    agentToolContext,
    describeError,
    fillActionPlaceholders,
    firstActionFor,
    firstScope,
} from './support';
import type { ActionView, WorkspaceView } from './views';

const workspace = (id: string, sessionIds: string[], scopes: string[] = []): WorkspaceView => ({
    id,
    actions: [],
    scopes: scopes.map((s) => ({ id: s, name: s, path: `/code/${s}` })),
    sessions: sessionIds.map((sid) => ({
        id: sid, workspaceId: id, name: sid, scopeId: 's', harnessId: 'claude', claudeSessionId: sid, createdAt: 0,
    })),
});

describe('describeError', () => {
    it.each([
        [new Error('boom'), 'boom'],
        ['plain', 'plain'],
        [42, '42'],
        [undefined, 'undefined'],
    ])('labels %s', (input, expected) => {
        expect(describeError(input)).toBe(expected);
    });
});

describe('agentToolContext', () => {
    it('scopes the call to the session\'s workspace, minus itself', () => {
        const ctx = agentToolContext('s2', [workspace('w1', ['s1']), workspace('w2', ['s2'])]);
        expect(ctx).toEqual({
            caller: { kind: 'agent', sessionId: 's2', workspaceId: 'w2' },
            scope: { workspaceIds: ['w2'], excludeSessionIds: ['s2'] },
        });
    });

    it('throws when the session is gone', () => {
        expect(() => agentToolContext('nope', [workspace('w1', ['s1'])])).toThrow('Calling session no longer exists.');
    });
});

describe('firstActionFor', () => {
    const actions: ActionView[] = [
        { name: 'Fix CI', appliesTo: ['pr'], prompt: 'x' },
        { name: 'Triage', appliesTo: ['issue'], prompt: 'y' },
        { name: 'Review', appliesTo: ['pr', 'issue'], prompt: 'z' },
    ];
    it('takes the first applicable action in order', () => {
        expect(firstActionFor(actions, 'pr')?.name).toBe('Fix CI');
        expect(firstActionFor(actions, 'issue')?.name).toBe('Triage');
    });
    it('is undefined when none applies', () => {
        expect(firstActionFor([actions[0]], 'issue')).toBeUndefined();
        expect(firstActionFor([], 'pr')).toBeUndefined();
    });
});

describe('firstScope', () => {
    it('is the first scope, or undefined with none', () => {
        expect(firstScope(workspace('w', [], ['a', 'b']))?.id).toBe('a');
        expect(firstScope(workspace('w', []))).toBeUndefined();
    });
});

describe('fillActionPlaceholders', () => {
    const item = {
        workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr' as const, number: 51 },
        title: 'Add retries',
        url: 'https://github.com/sprocket/catalog-portal/pull/51',
    };
    it('fills the five names, with or without spaces', () => {
        expect(fillActionPlaceholders('{{number}} {{ repo }} {{title}} {{url}} {{type}}', item)).toBe(
            '51 sprocket/catalog-portal Add retries https://github.com/sprocket/catalog-portal/pull/51 pull request'
        );
    });
    it('says issue for an issue', () => {
        expect(fillActionPlaceholders('{{type}}', { ...item, workItem: { ...item.workItem, type: 'issue' } })).toBe('issue');
    });
    it('leaves unknown names and bare text as typed', () => {
        expect(fillActionPlaceholders('{{other}} /review', item)).toBe('{{other}} /review');
    });
});

describe('StartedByHandError', () => {
    it('names the session', () => {
        const error = new StartedByHandError('Review #51');
        expect(error.message).toBe('Already started by hand: “Review #51”.');
        expect(error.name).toBe('StartedByHandError');
        expect(error.sessionName).toBe('Review #51');
    });
});

describe('CONSOLA_NAMESPACE', () => {
    it('is consola', () => expect(CONSOLA_NAMESPACE).toBe('consola'));
});
