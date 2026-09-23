import { spawn } from 'child_process';
import { z } from 'zod';
import type { HarnessModel } from '../../shared/types';

const pageSchema = z.object({
    data: z.array(z.object({
        model: z.string().min(1),
        displayName: z.string().min(1),
        description: z.string().optional(),
        hidden: z.boolean().optional(),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
    })),
    nextCursor: z.string().nullable().optional(),
});

/** Only shared config flags belong on app-server, not interactive TUI flags. */
export function codexModelConfigArgs(args: string[]): string[] {
    const result: string[] = [];
    const flags = ['-c', '--config', '--enable', '--disable'];
    for (let i = 0; i < args.length; i++) {
        if (flags.includes(args[i]) && i + 1 < args.length) result.push(args[i], args[++i]);
        else if (flags.some(flag => args[i].startsWith(`${flag}=`))) result.push(args[i]);
    }
    return result;
}

/** Discover this installation/profile's picker models without creating a thread.
 * Protocol: https://learn.chatgpt.com/docs/app-server#list-models-modellist
 */
export function listCodexModels(
    binary: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    extraArgs: string[] = [],
    timeoutMs = 15000
): Promise<HarnessModel[]> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['app-server', ...codexModelConfigArgs(extraArgs)], { cwd, env, stdio: 'pipe' });
        const models = new Map<string, HarnessModel>();
        const cursors = new Set<string>();
        let settled = false;
        let requestId = 1;
        let pending = '';
        let received = 0;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            // No thread or turn exists here, so there is no rollout to flush.
            child.kill('SIGKILL');
            if (error) reject(error);
            else resolve([...models.values()]);
        };
        const timer = setTimeout(() => finish(new Error('Codex model discovery timed out. Try again.')), timeoutMs);
        const send = (id: number | undefined, method: string, params: object) => {
            child.stdin.write(JSON.stringify({ ...(id !== undefined ? { id } : {}), method, params }) + '\n');
        };
        const nextPage = (cursor?: string) => send(++requestId, 'model/list', {
            limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
        });
        const ioError = () => finish(new Error('Could not load Codex models. Check the binary path and profile configuration.'));
        child.on('error', ioError);
        child.on('close', () => finish(new Error('Codex exited before returning its models.')));
        child.stdin.on('error', ioError);
        child.stdout.on('error', ioError);
        child.stderr.on('error', ioError);
        // Protocol diagnostics may contain credentials; never expose raw output.
        child.stderr.resume();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (settled) return;
            received += chunk.length;
            if (received > 4 * 1024 * 1024) {
                finish(new Error('Codex model response exceeded the size limit.'));
                return;
            }
            pending += chunk;
            let newline: number;
            while (!settled && (newline = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line);
                    if (message?.id !== requestId) continue;
                    if (message.error) {
                        finish(new Error('Codex could not list models. Check the CLI version and profile, then retry.'));
                        continue;
                    }
                    if (requestId === 1) {
                        if (!message.result || typeof message.result !== 'object') throw new Error('Missing initialization');
                        send(undefined, 'initialized', {});
                        nextPage();
                        continue;
                    }
                    const page = pageSchema.parse(message.result);
                    for (const model of page.data) {
                        if (model.hidden) continue;
                        const efforts = model.supportedReasoningEfforts?.map(item => item.reasoningEffort);
                        models.set(model.model, {
                            value: model.model, resolvedModel: model.model,
                            displayName: model.displayName, description: model.description ?? '',
                            supportsEffort: Boolean(efforts?.length), supportedEffortLevels: efforts,
                        });
                    }
                    if (page.nextCursor) {
                        if (cursors.has(page.nextCursor)) throw new Error('Repeated cursor');
                        cursors.add(page.nextCursor);
                        nextPage(page.nextCursor);
                    } else finish();
                } catch {
                    finish(new Error('Invalid model response from Codex. Check the CLI version and try again.'));
                }
            }
        });
        send(1, 'initialize', { clientInfo: { name: 'consola', title: 'Consola', version: '1.0.0' } });
    });
}
