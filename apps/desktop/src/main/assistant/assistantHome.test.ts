import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceFactoryPath } from '../automations/FactoryFile';
import { assistantFolder, ensureAssistantHome } from './assistantHome';

describe('assistantHome', () => {
    let root: string;
    let previous: string | undefined;

    beforeEach(() => {
        previous = process.env.CONSOLA_FACTORY_DIR;
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-assistant-'));
        process.env.CONSOLA_FACTORY_DIR = root;
    });

    afterEach(() => {
        if (previous === undefined) delete process.env.CONSOLA_FACTORY_DIR;
        else process.env.CONSOLA_FACTORY_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('creates the folder and its brief beside factory.yml', async () => {
        const dir = await ensureAssistantHome('ws1', 'catalog-portal');
        expect(dir).toBe(path.join(root, 'ws1', 'assistant'));
        expect(path.dirname(workspaceFactoryPath('ws1'))).toBe(path.dirname(dir));
        const brief = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
        expect(brief).toContain('**catalog-portal**');
        for (const tool of ['consola_list_sessions', 'consola_read_session', 'consola_prompt_session', 'consola_start_session']) {
            expect(brief).toContain(tool);
        }
    });

    it('never overwrites a brief the person edited', async () => {
        const dir = await ensureAssistantHome('ws1', 'catalog-portal');
        fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine');
        await ensureAssistantHome('ws1', 'renamed');
        expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('mine');
    });

    it('refuses a workspace id that is not a token', () => {
        expect(() => assistantFolder('../x')).toThrow(/Not a workspace id/);
    });
});
