import { describe, expect, it, vi } from 'vitest';
import { ClaudeDriver } from './ClaudeDriver';
import { CodexDriver } from './CodexDriver';
import { toolPolicyProblem } from './index';
import type { HarnessConfig } from './HarnessDriver';

vi.mock('../LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: process.env.PATH }) }));

const claude = new ClaudeDriver();

describe('Claude read-only launches', () => {
    const config: HarnessConfig = { extraArgs: ['--verbose'] };

    it('restricts the CLI before the harness extra args, closing its tool list with a flag', () => {
        const args = claude.buildSessionArgs(config, {
            sessionId: 'abc',
            resume: false,
            mcpConfigPath: '/tmp/session.json',
            toolPolicy: 'read-only',
        });
        expect(args).toEqual([
            '--session-id', 'abc',
            '--mcp-config', '/tmp/session.json',
            '--strict-mcp-config',
            '--permission-mode', 'dontAsk',
            // Reading files, and nothing that runs: no shell rule is safe.
            '--tools', 'Read,Grep,Glob',
            // The item and the Inbox come from Consola, which holds the token.
            '--allowedTools', 'mcp__consola__consola_work_item_context', 'mcp__consola__consola_list_inbox',
            // A flag that takes no value: it ends the tool list above, and
            // nothing after it can be read as one of its values.
            '--restricted',
            '--verbose',
        ]);
    });

    it('puts the read-only flags before the harness extra args, so a dangling value cannot take one', () => {
        // `--append-system-prompt` wants a value: placed before the policy, it would take `--restricted`.
        const args = claude.buildSessionArgs({ extraArgs: ['--append-system-prompt'] }, { sessionId: 'abc', resume: false, toolPolicy: 'read-only' });
        expect(args.indexOf('--restricted')).toBeLessThan(args.indexOf('--append-system-prompt'));
        expect(args.indexOf('--permission-mode')).toBeLessThan(args.indexOf('--append-system-prompt'));
        expect(args.indexOf('--tools')).toBeLessThan(args.indexOf('--append-system-prompt'));
    });

    it('replays the policy on every resume', () => {
        const args = claude.buildSessionArgs(config, { sessionId: 'abc', resume: true, toolPolicy: 'read-only' });
        expect(args.slice(0, 2)).toEqual(['--resume', 'abc']);
        expect(args).toContain('--restricted');
    });

    it('launches exactly as before with no policy', () => {
        expect(claude.buildSessionArgs(config, { sessionId: 'abc', resume: true })).toEqual(['--resume', 'abc', '--verbose']);
    });

    it.each([
        ['--dangerously-skip-permissions'],
        ['--allow-dangerously-skip-permissions'],
        ['--permission-mode', 'bypassPermissions'],
        ['--permission-mode=acceptEdits'],
        ['--allowedTools', 'Bash'],
        ['--allowed-tools=Bash'],
        ['--tools', 'default'],
        ['--settings', '/tmp/s.json'],
        ['--setting-sources', 'project'],
        ['--add-dir', '/Users/me'],
        ['--plugin-dir', '/tmp/plugin'],
        ['--agents', '{}'],
    ])('refuses a harness whose extra args loosen it: %s', (...extraArgs) => {
        const loose: HarnessConfig = { extraArgs };
        expect(claude.toolPolicyProblem(loose, 'read-only')).toMatch(new RegExp(extraArgs[0].split('=')[0]));
        expect(() => claude.buildSessionArgs(loose, { sessionId: 'abc', resume: false, toolPolicy: 'read-only' })).toThrow(
            /read-only/
        );
        // Without a policy the same harness launches as it always has.
        expect(claude.toolPolicyProblem(loose, undefined)).toBeNull();
    });
});

describe('Claude unattended and forked launches', () => {
    const config: HarnessConfig = { extraArgs: ['--verbose'] };
    const READ_ONLY = [
        '--strict-mcp-config',
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Grep,Glob',
        '--allowedTools', 'mcp__consola__consola_work_item_context', 'mcp__consola__consola_list_inbox',
        '--restricted',
    ];

    it('builds the unattended argv', () => {
        const args = claude.buildSessionArgs(config, {
            sessionId: 'abc',
            resume: false,
            model: 'opus',
            mcpConfigPath: '/tmp/session.json',
            toolPolicy: 'read-only',
            unattended: true,
            initialPrompt: 'Review it.',
        });
        // The prompt after `--`, last: `--allowedTools` takes several values and would swallow it.
        expect(args).toEqual([
            '-p',
            '--session-id', 'abc',
            '--model', 'opus',
            '--mcp-config', '/tmp/session.json',
            ...READ_ONLY,
            '--verbose',
            '--', 'Review it.',
        ]);
        // An interrupted turn resumes the same conversation, still unattended.
        expect(
            claude.buildSessionArgs(config, { sessionId: 'abc', resume: true, toolPolicy: 'read-only', unattended: true, initialPrompt: 'Go on.' })
        ).toEqual(['-p', '--resume', 'abc', ...READ_ONLY, '--verbose', '--', 'Go on.']);
    });

    it('refuses an unattended turn without read-only', () => {
        expect(() => claude.buildSessionArgs(config, { sessionId: 'abc', resume: false, unattended: true, initialPrompt: 'Review it.' })).toThrow(
            'A turn nobody is watching skips Claude’s folder-trust prompt, so Consola runs one only in a read-only session.'
        );
    });

    it('refuses an unattended turn with no prompt', () => {
        expect(() => claude.buildSessionArgs(config, { sessionId: 'abc', resume: false, unattended: true, toolPolicy: 'read-only' })).toThrow(
            'An unattended turn needs the prompt it runs.'
        );
    });

    it('builds the fork argv without read-only flags', () => {
        expect(claude.buildSessionArgs({ extraArgs: [] }, { sessionId: 'new', resume: false, forkFrom: 'orig' })).toEqual([
            '--resume', 'orig', '--fork-session', '--session-id', 'new',
        ]);
    });
});

describe('Codex read-only launches', () => {
    it('Codex refuses unattended and fork', async () => {
        const codex = new CodexDriver();
        const refusal = 'This harness can’t run a turn unattended or continue a conversation in a new session.';
        await expect(
            codex.buildSessionArgs({ extraArgs: [] }, { sessionId: 'abc', resume: false, unattended: true, initialPrompt: 'Review it.' })
        ).rejects.toThrow(refusal);
        await expect(codex.buildSessionArgs({ extraArgs: [] }, { sessionId: 'new', resume: false, forkFrom: 'orig' })).rejects.toThrow(refusal);
    });

    it('are refused: its MCP servers and project config cannot be shut out yet', async () => {
        const codex = new CodexDriver();
        expect(codex.toolPolicyProblem({ extraArgs: [] }, 'read-only')).toMatch(/Codex sessions cannot be made read-only/);
        await expect(
            codex.buildSessionArgs({ extraArgs: [] }, { sessionId: 'abc', resume: true, toolPolicy: 'read-only' })
        ).rejects.toThrow(/cannot be made read-only/);
        expect(codex.toolPolicyProblem({ extraArgs: ['--full-auto'] }, undefined)).toBeNull();
    });
});

describe('toolPolicyProblem', () => {
    it('asks the session’s driver, with the harness fields as launched', () => {
        expect(toolPolicyProblem({}, 'read-only')).toBeNull();
        expect(toolPolicyProblem({ extraArgs: ['--dangerously-skip-permissions'] }, 'read-only')).toMatch(
            /dangerously-skip-permissions/
        );
        expect(toolPolicyProblem({ driverId: 'codex' }, 'read-only')).toMatch(/Codex/);
        expect(toolPolicyProblem({ extraArgs: ['--dangerously-skip-permissions'] }, undefined)).toBeNull();
    });
});
