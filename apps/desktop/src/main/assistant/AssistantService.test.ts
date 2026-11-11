import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { AssistantService, type AssistantServiceDeps } from './AssistantService';

function record(id: string, kind: Session['kind']): Session {
    return {
        id,
        workspaceId: 'ws1',
        instanceId: `i-${id}`,
        claudeSessionId: id,
        name: 'Assistant',
        hasStarted: false,
        harnessId: 'work',
        scopeId: 'sc1',
        kind,
        createdAt: 0,
        lastActiveAt: 0,
    };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
    return {
        id: 'ws1',
        name: 'catalog-portal',
        defaultHarnessId: 'work',
        scopes: [{ id: 'sc1', name: 'app', path: '/repo/app', isGitRepo: true, createdAt: 0 }],
        groups: [],
        actions: [],
        sectionDefaults: {},
        sessions: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    } as Workspace;
}

describe('AssistantService', () => {
    let current: Workspace;
    let deps: AssistantServiceDeps;
    let service: AssistantService;
    let counter: number;

    beforeEach(() => {
        current = workspace();
        counter = 0;
        deps = {
            workspaces: {
                getAll: vi.fn(() => [current]),
                ensureAssistant: vi.fn((_id: string, _fields: { harnessId: string; cwd: string }) => {
                    const existing = current.sessions.find((s) => s.kind === 'assistant');
                    if (existing) return existing;
                    const created = record(`a${++counter}`, 'assistant');
                    current.sessions.push(created);
                    return created;
                }),
                replaceAssistant: vi.fn((_id: string, _fields: { harnessId: string; cwd: string }) => {
                    const previous = current.sessions.find((s) => s.kind === 'assistant');
                    const next = record(`a${++counter}`, 'assistant');
                    current.sessions = [next];
                    return { previous, next };
                }),
            },
            ensureHome: vi.fn(async () => '/home/ws1/assistant'),
            stop: vi.fn(),
        };
        service = new AssistantService(deps);
    });

    it('creates the record on first open, on the default harness, in its home — and starts nothing', async () => {
        const session = await service.open('ws1');
        expect(deps.ensureHome).toHaveBeenCalledWith('ws1', 'catalog-portal');
        expect(deps.workspaces.ensureAssistant).toHaveBeenCalledWith('ws1', { harnessId: 'work', cwd: '/home/ws1/assistant' });
        expect(session.kind).toBe('assistant');
        expect(deps.stop).not.toHaveBeenCalled();
    });

    it('returns the existing one without rewriting its home', async () => {
        const existing = record('old', 'assistant');
        current.sessions.push(existing);
        await expect(service.open('ws1')).resolves.toBe(existing);
        expect(deps.ensureHome).not.toHaveBeenCalled();
        expect(deps.workspaces.ensureAssistant).not.toHaveBeenCalled();
    });

    it('refuses a workspace with no scopes', async () => {
        current = workspace({ scopes: [] });
        await expect(service.open('ws1')).rejects.toThrow('Add a scope to use the Assistant.');
        expect(deps.ensureHome).not.toHaveBeenCalled();
    });

    it('refuses an unknown workspace', async () => {
        await expect(service.open('nope')).rejects.toThrow('Workspace not found.');
    });

    it('returns the record a concurrent open made while the home was being created', async () => {
        const winner = record('winner', 'assistant');
        deps.ensureHome = vi.fn(async () => {
            current.sessions.push(winner);
            return '/home/ws1/assistant';
        });
        service = new AssistantService(deps);
        await expect(service.open('ws1')).resolves.toBe(winner);
    });

    it('starts fresh on the current default harness and stops the old one', async () => {
        const previous = record('old', 'assistant');
        current.sessions.push(previous);
        const next = await service.startFresh('ws1');
        expect(deps.workspaces.replaceAssistant).toHaveBeenCalledWith('ws1', { harnessId: 'work', cwd: '/home/ws1/assistant' });
        expect(deps.stop).toHaveBeenCalledWith(previous);
        expect(next.id).not.toBe(previous.id);
    });

    it('starts fresh without stopping anything when there was no Assistant', async () => {
        const next = await service.startFresh('ws1');
        expect(next.kind).toBe('assistant');
        expect(deps.stop).not.toHaveBeenCalled();
    });
});
