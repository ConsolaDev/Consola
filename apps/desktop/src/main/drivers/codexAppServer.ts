import { spawn } from 'node:child_process';
import { codexPlanApplies } from './codexUsage';
import type { CodexUsageAnswer } from './codexUsage';

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
  timeoutMs = 15000,
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
      timeoutMs,
    );
    const send = (id: number | undefined, method: string, params: object) => {
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    };
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (prepared && code === 0) finish();
      else finish(new Error('Codex app-server exited before preparing the conversation.'));
    });
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('error', (error) => finish(error));
    child.stderr.on('error', (error) => finish(error));
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
      // biome-ignore lint/suspicious/noAssignInExpressions: takes one complete line per pass until none is left
      while (!settled && (newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (![1, 2, 3, 4].includes(message.id)) continue;
          if (message.error) {
            finish(
              new Error(
                'Codex could not prepare the conversation. Check the CLI version and profile configuration.',
              ),
            );
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

/**
 * Ask Codex who is signed in and, when a ChatGPT plan applies, that plan's
 * rate limits — without starting a thread, so no turn runs and nothing is
 * written. `configArgs` are the harness's own `-c` overrides, which can point
 * it at another provider.
 *
 * Rejects on a JSON-RPC error or an account answer it cannot read: the caller
 * then knows nothing, which is better than a guess.
 */
export function readCodexRateLimits(
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  configArgs: string[] = [],
  timeoutMs = 10000,
): Promise<CodexUsageAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', ...configArgs], { cwd, env, stdio: 'pipe' });
    let settled = false;
    let account: Pick<CodexUsageAnswer, 'accountType' | 'requiresOpenaiAuth'> | undefined;
    const finish = (error: Error | null, answer?: CodexUsageAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // No thread was started, so there is nothing to flush.
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(answer!);
    };
    const timer = setTimeout(
      () => finish(new Error('Codex did not report its rate limits within the timeout.')),
      timeoutMs,
    );
    const send = (id: number | undefined, method: string, params: object | null) => {
      child.stdin.write(
        `${JSON.stringify({ ...(id === undefined ? {} : { id }), method, params })}\n`,
      );
    };
    const ioError = () => finish(new Error('Could not run Codex to read its rate limits.'));
    child.on('error', ioError);
    child.on('close', () => finish(new Error('Codex exited before reporting its rate limits.')));
    child.stdin.on('error', ioError);
    child.stdout.on('error', ioError);
    child.stderr.on('error', ioError);
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
      // biome-ignore lint/suspicious/noAssignInExpressions: takes one complete line per pass until none is left
      while (!settled && (newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error('Invalid response from Codex app-server.'));
          return;
        }
        // Notifications carry no id; only answers to the requests below matter.
        if (![1, 2, 3].includes(message?.id as number)) continue;
        if (message.error) {
          finish(
            new Error('Codex could not report its rate limits. Check the CLI version and profile.'),
          );
          return;
        }
        try {
          if (message.id === 1) {
            send(undefined, 'initialized', {});
            send(2, 'account/read', {});
          } else if (message.id === 2) {
            const result = message.result as {
              account?: { type?: unknown } | null;
              requiresOpenaiAuth?: unknown;
            } | null;
            // Kept to the account's type alone: its email and ids are not ours to pass on.
            account = {
              accountType: result?.account === null ? null : result?.account?.type,
              requiresOpenaiAuth: result?.requiresOpenaiAuth,
            };
            if (codexPlanApplies(account)) send(3, 'account/rateLimits/read', null);
            else finish(null, account);
          } else if (message.id === 3 && account) {
            const result = message.result;
            // The snapshots alone: the result also names the account and its reset credits.
            const rateLimits =
              typeof result === 'object' && result !== null
                ? {
                    rateLimits: (result as { rateLimits?: unknown }).rateLimits,
                    rateLimitsByLimitId: (result as { rateLimitsByLimitId?: unknown })
                      .rateLimitsByLimitId,
                  }
                : result;
            finish(null, { ...account, rateLimits });
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'consola', title: 'Consola', version: '1.0.0' } });
  });
}
