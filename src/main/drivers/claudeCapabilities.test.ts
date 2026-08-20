import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapInitializeResponse, requestInitializeHandshake } from './claudeCapabilities';

/**
 * The handshake is the one part of this feature that talks to another process,
 * so it is exercised against real spawned children rather than a mocked
 * `child_process`. Each fake CLI below is a tiny Node script standing in for a
 * `claude` that behaves badly in a specific way — the failures that matter are
 * a hung child, a build too old to answer, and output that no longer parses.
 */

const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-capabilities-'));

afterAll(() => {
    fs.rmSync(scriptDir, { recursive: true, force: true });
});

/**
 * Run the handshake against a fake CLI.
 *
 * `requestInitializeHandshake` spawns a binary with a fixed argument list, so
 * the fake is wrapped in a small executable shim that already knows which
 * script to run.
 */
function runAgainst(scriptBody: string, timeoutMs = 5000): Promise<unknown> {
    const file = path.join(scriptDir, `cli-${Math.abs(hash(scriptBody))}.cjs`);
    fs.writeFileSync(file, scriptBody, 'utf8');
    const shim = path.join(scriptDir, `shim-${Math.abs(hash(scriptBody))}.sh`);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}"\n`, 'utf8');
    fs.chmodSync(shim, 0o755);
    return requestInitializeHandshake(shim, scriptDir, process.env, timeoutMs);
}

function hash(value: string): number {
    let result = 0;
    for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
    return result;
}

const ANSWER = {
    commands: [{ name: 'commit', description: 'Create a git commit', argumentHint: '' }],
    agents: [{ name: 'Explore', description: 'Read-only search agent' }],
    models: [
        {
            value: 'sonnet',
            resolvedModel: 'claude-sonnet-5',
            displayName: 'Sonnet',
            description: 'Efficient for routine tasks',
        },
    ],
    available_output_styles: ['default', 'Concise'],
    account: { email: 'someone@example.com', subscriptionType: 'Claude Max' },
};

describe('requestInitializeHandshake', () => {
    it('reads the answer even when it arrives split across chunks', async () => {
        // The real CLI's response runs to tens of kilobytes and never lands in
        // one read. Splitting mid-line is the case that a naive
        // split-each-chunk parser gets wrong.
        const line = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
        });
        const result = await runAgainst(`
            const line = ${JSON.stringify(line)};
            process.stdout.write(line.slice(0, 20));
            setTimeout(() => process.stdout.write(line.slice(20, 60)), 10);
            setTimeout(() => process.stdout.write(line.slice(60) + "\\n"), 20);
            setTimeout(() => {}, 5000);
        `);

        expect(mapInitializeResponse(result).commands).toHaveLength(1);
    });

    it('ignores hook chatter and unparseable lines before the answer', async () => {
        const line = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
        });
        const result = await runAgainst(`
            process.stdout.write('not json at all\\n');
            process.stdout.write(JSON.stringify({type:'system',subtype:'hook_started'}) + "\\n");
            process.stdout.write(${JSON.stringify(line)} + "\\n");
            setTimeout(() => {}, 5000);
        `);

        expect(mapInitializeResponse(result).agents[0].name).toBe('Explore');
    });

    it('rejects when the CLI exits without answering, quoting its stderr', async () => {
        // What an older build does: it does not recognise the flags and dies.
        await expect(
            runAgainst(`
                process.stderr.write('unknown option --input-format');
                process.exit(2);
            `)
        ).rejects.toThrow(/unknown option --input-format/);
    });

    it('rejects rather than hanging when no answer ever comes', async () => {
        await expect(
            runAgainst(`setTimeout(() => {}, 60000);`, 300)
        ).rejects.toThrow(/within 300ms/);
    });

    it('rejects when the CLI reports an error for the request', async () => {
        const line = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'error',
                request_id: 'consola-initialize',
                error: 'initialize is not supported',
            },
        });
        await expect(
            runAgainst(`
                process.stdout.write(${JSON.stringify(line)} + "\\n");
                setTimeout(() => {}, 5000);
            `)
        ).rejects.toThrow(/initialize is not supported/);
    });

    it('rejects when the binary does not exist instead of crashing the process', async () => {
        await expect(
            requestInitializeHandshake(
                path.join(scriptDir, 'definitely-not-here'),
                scriptDir,
                process.env,
                2000
            )
        ).rejects.toThrow();
    });

    it('leaves no child running once it has its answer', async () => {
        // A CLI that would sit forever if nobody killed it.
        const line = JSON.stringify({
            type: 'control_response',
            response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
        });
        const marker = path.join(scriptDir, 'still-alive');
        await runAgainst(`
            process.stdout.write(${JSON.stringify(line)} + "\\n");
            setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 400);
            setTimeout(() => {}, 5000);
        `);
        await new Promise((resolve) => setTimeout(resolve, 700));

        expect(fs.existsSync(marker)).toBe(false);
    });
});

describe('mapInitializeResponse', () => {
    it('maps a full answer', () => {
        const capabilities = mapInitializeResponse(ANSWER);

        expect(capabilities.commands[0]).toEqual({
            name: 'commit',
            description: 'Create a git commit',
            argumentHint: undefined,
            aliases: undefined,
        });
        expect(capabilities.models[0].resolvedModel).toBe('claude-sonnet-5');
        expect(capabilities.outputStyles).toEqual(['default', 'Concise']);
        expect(capabilities.account).toMatchObject({
            signedIn: true,
            subscriptionType: 'Claude Max',
        });
    });

    it('reports a signed-out profile as signed out rather than dropping it', () => {
        const capabilities = mapInitializeResponse({
            ...ANSWER,
            account: { tokenSource: 'none', apiProvider: 'firstParty' },
        });

        expect(capabilities.account).toMatchObject({ signedIn: false });
    });

    it('tolerates a missing agent or model list', () => {
        const capabilities = mapInitializeResponse({ commands: [] });

        expect(capabilities.agents).toEqual([]);
        expect(capabilities.models).toEqual([]);
    });

    it('drops entries with no name rather than rendering a blank row', () => {
        const capabilities = mapInitializeResponse({
            commands: [{ description: 'nameless' }, { name: 'ok', description: '' }],
        });

        expect(capabilities.commands.map((command) => command.name)).toEqual(['ok']);
    });

    it('throws on a shape it does not recognise, rather than reporting no commands', () => {
        // The failure this guards: a future CLI renames the field, every
        // harness silently shows an empty menu, and nothing says why.
        expect(() => mapInitializeResponse({ slashCommands: [] })).toThrow(/command list/);
        expect(() => mapInitializeResponse('nope')).toThrow(/object/);
    });
});
