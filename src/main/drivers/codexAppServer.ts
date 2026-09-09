import { spawn } from 'child_process';

/**
 * Reserve a resumable Codex conversation without running a model turn.
 * Naming and resuming materialize the initially lazy rollout before the TUI attaches.
 * Protocol: https://learn.chatgpt.com/docs/app-server
 */
export function createCodexThread(
    binary: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    name: string,
    timeoutMs = 15000
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['app-server'], { cwd, env, stdio: 'pipe' });
        let settled = false;
        let prepared = false;
        let threadId: string | undefined;
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) child.kill('SIGKILL');
            if (error) reject(error);
            else resolve(threadId!);
        };
        const timer = setTimeout(
            () => finish(new Error('Codex did not prepare a conversation within the timeout.')),
            timeoutMs
        );
        const send = (id: number | undefined, method: string, params: object) => {
            child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        };
        child.on('error', error => finish(error));
        child.on('close', code => {
            if (prepared && code === 0) finish();
            else finish(new Error('Codex app-server exited before preparing the conversation.'));
        });
        child.stdin.on('error', error => finish(error));
        child.stdout.on('error', error => finish(error));
        child.stderr.on('error', error => finish(error));
        // Drain logs, but never surface protocol/config diagnostics containing credentials.
        child.stderr.resume();
        let pending = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (settled) return;
            pending += chunk;
            if (pending.length > 4 * 1024 * 1024) {
                finish(new Error('Codex app-server response exceeded the size limit.'));
                return;
            }
            let newline: number;
            while (!settled && (newline = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                if (!line.trim()) continue;
                try {
                    const message = JSON.parse(line);
                    if (![1, 2, 3, 4].includes(message.id)) continue;
                    if (message.error) {
                        finish(new Error('Codex could not prepare the conversation. Check the CLI version and profile configuration.'));
                    } else if (message.id === 1) {
                        send(undefined, 'initialized', {});
                        send(2, 'thread/start', { cwd });
                    } else if (message.id === 2) {
                        const id = message.result?.thread?.id;
                        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
                            throw new Error('Missing thread ID');
                        }
                        threadId = id;
                        send(3, 'thread/name/set', { threadId, name });
                    } else if (message.id === 3 && threadId && message.result) {
                        send(4, 'thread/resume', { threadId });
                    } else if (message.id === 4 && message.result?.thread?.id === threadId) {
                        // The acknowledgement precedes the buffered rollout write.
                        // EOF asks Codex to flush and exit; wait for close before
                        // allowing another process to resume this conversation.
                        prepared = true;
                        child.stdin.end();
                    } else {
                        throw new Error('Missing result');
                    }
                } catch {
                    finish(new Error('Invalid response from Codex app-server.'));
                }
            }
        });
        send(1, 'initialize', { clientInfo: { name: 'consola', title: 'Consola', version: '1.0.0' } });
    });
}
