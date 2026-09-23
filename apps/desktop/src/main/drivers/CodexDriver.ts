import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { HarnessCapabilities, HarnessProbeResult } from '../../shared/types';
import { getLoginEnv } from '../LoginEnvironment';
import { JsonStateFile } from '../state/JsonStateFile';
import type { HarnessConfig, HarnessDriver, SessionLaunch } from './HarnessDriver';
import { findCodexRollout, readSessionModel } from './sessionModel';
import { createCodexThread } from './codexAppServer';
import { listCodexModels } from './codexModels';
import { readCodexSessionName } from './codexSessionName';

interface CodexMapping { threadId: string; pendingThreadPrefix?: string }

/** Resolve only a unique native UUID prefix, never the latest thread in a cwd. */
function threadForPrefix(home: string, prefix: string): string | undefined {
    const ids = new Set<string>();
    const visit = (directory: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) visit(path.join(directory, entry.name));
            else if (entry.isFile()) {
                const id = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(entry.name)?.[1];
                if (id?.startsWith(prefix)) ids.add(id);
            }
        }
    };
    visit(path.join(home, 'sessions'));
    visit(path.join(home, 'archived_sessions'));
    return ids.size === 1 ? [...ids][0] : undefined;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
    } catch { return false; }
}

const mcpSchema = z.object({ mcpServers: z.record(z.object({
    type: z.literal('stdio').optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
}).strict()) });

/** JSON string escaping is also valid for TOML basic strings. */
function toml(value: string | string[] | Record<string, string>): string {
    if (typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
    return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(', ')} }`;
}

function mcpArgs(file?: string): string[] {
    if (!file) return [];
    const parsed = mcpSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error('Codex requires a supported stdio MCP configuration.');
    return Object.entries(parsed.data.mcpServers).flatMap(([name, server]) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MCP server name.');
        const fields = [`command = ${toml(server.command)}`, 'required = true'];
        if (server.args) fields.push(`args = ${toml(server.args)}`);
        if (server.env) fields.push(`env = ${toml(server.env)}`);
        return ['-c', `mcp_servers.${name}={ ${fields.join(', ')} }`];
    });
}

export class CodexDriver implements HarnessDriver {
    public readonly id = 'codex' as const;
    public readonly configDirEnvVar = 'CODEX_HOME';
    public readonly initialPromptViaArgs = true;
    public readonly retryResumeAsFresh = false;
    private readonly preparing = new Map<string, Promise<string>>();

    private readonly rolloutFiles = new Map<string, string>();

    public async getSessionDisplayName(config: HarnessConfig, sessionId: string) {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
        const home = config.configDir || getLoginEnv().CODEX_HOME || path.join(os.homedir(), '.codex');
        try {
            const mapping: CodexMapping = JSON.parse(await fs.promises.readFile(
                path.join(home, 'consola', 'sessions', `${sessionId}.json`), 'utf8'
            ));
            const threadId = mapping.pendingThreadPrefix
                ? (/^[0-9a-f-]{29}$/i.test(mapping.pendingThreadPrefix)
                    ? threadForPrefix(home, mapping.pendingThreadPrefix) : undefined)
                : mapping.threadId;
            if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(threadId)) return null;
            const key = path.join(home, threadId);
            let file = this.rolloutFiles.get(key);
            if (!file || !fs.existsSync(file)) {
                file = await findCodexRollout(path.join(home, 'sessions'), threadId)
                    ?? await findCodexRollout(path.join(home, 'archived_sessions'), threadId)
                    ?? undefined;
                if (file) this.rolloutFiles.set(key, file);
            }
            return await readCodexSessionName(path.join(home, 'session_index.jsonl'), threadId, sessionId, file);
        } catch { return null; }
    }

    public async getSessionModel(config: HarnessConfig, sessionId: string): Promise<string | null> {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
        const home = config.configDir || getLoginEnv().CODEX_HOME || path.join(os.homedir(), '.codex');
        try {
            const mapping = JSON.parse(await fs.promises.readFile(
                path.join(home, 'consola', 'sessions', `${sessionId}.json`), 'utf8'
            ));
            const threadId = mapping?.threadId;
            if (typeof threadId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(threadId)) return null;
            const key = path.join(home, threadId);
            let file = this.rolloutFiles.get(key);
            if (!file || !fs.existsSync(file)) {
                file = await findCodexRollout(path.join(home, 'sessions'), threadId)
                    ?? await findCodexRollout(path.join(home, 'archived_sessions'), threadId)
                    ?? undefined;
                if (file) this.rolloutFiles.set(key, file);
            }
            return file ? readSessionModel(file, 'codex') : null;
        } catch { return null; }
    }

    public resolveBinary(config: HarnessConfig): string {
        if (config.binaryPath) return config.binaryPath;
        const dirs = (getLoginEnv().PATH ?? '').split(path.delimiter).filter(Boolean);
        const candidates = [
            ...dirs.map(dir => path.join(dir, 'codex')),
            path.join(os.homedir(), '.local/bin/codex'),
            '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
        ];
        return candidates.find(isExecutable) ?? 'codex';
    }

    public composeEnv(config: HarnessConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return config.configDir ? { ...baseEnv, CODEX_HOME: config.configDir } : { ...baseEnv };
    }

    public async buildSessionArgs(config: HarnessConfig, launch: SessionLaunch): Promise<string[]> {
        const mcp = mcpArgs(launch.mcpConfigPath);
        const threadId = await this.resolveThread(config, launch);
        return [
            'resume', threadId,
            ...(launch.model ? ['--model', launch.model] : []),
            ...config.extraArgs,
            ...mcp,
            // OSC title updates follow /new, /clear and /resume in this PTY.
            // Keep this after profile overrides: it is our session identity channel.
            '-c', 'tui.terminal_title=["thread-id"]',
            ...(launch.initialPrompt ? ['--', launch.initialPrompt] : []),
        ];
    }

    public createOutputObserver(config: HarnessConfig, sessionId: string): (data: string) => void {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Consola session ID.');
        const home = this.composeEnv(config, getLoginEnv()).CODEX_HOME || path.join(os.homedir(), '.codex');
        const file = new JsonStateFile<CodexMapping>(path.join(home, 'consola', 'sessions', `${sessionId}.json`));
        let mapping = file.read();
        let pending = '';
        let nextLookup = 0;
        return data => {
            // Parse only OSC 0/2 titles, never UUIDs in model output or resume hints.
            // A sequence can arrive split anywhere across PTY chunks.
            pending += data;
            while (pending) {
                const start = pending.indexOf('\x1b]');
                if (start < 0) {
                    pending = pending.endsWith('\x1b') ? '\x1b' : '';
                    break;
                }
                pending = pending.slice(start);
                const end = /\x07|\x1b\\/.exec(pending);
                if (!end) {
                    if (pending.length > 1024) pending = '';
                    break;
                }
                const title = pending.slice(2, end.index);
                pending = pending.slice(end.index + end[0].length);
                const match = /^[02];([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(title);
                if (match && (match[1] !== mapping?.threadId || mapping.pendingThreadPrefix)) {
                    file.write({ threadId: match[1] });
                    mapping = { threadId: match[1] };
                }
                // Codex 0.153 shortens a title item to 29 characters plus "...".
                const shortened = /^[02];([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5})\.\.\.$/i.exec(title);
                if (shortened && mapping && !mapping.threadId.startsWith(shortened[1])) {
                    if (mapping.pendingThreadPrefix !== shortened[1]) {
                        mapping = { threadId: mapping.threadId, pendingThreadPrefix: shortened[1] };
                        // Persist before the lazy rollout appears, including across app exit.
                        file.write(mapping);
                        nextLookup = 0;
                    }
                } else if (shortened && mapping?.pendingThreadPrefix && mapping.threadId.startsWith(shortened[1])) {
                    mapping = { threadId: mapping.threadId };
                    file.write(mapping);
                }
            }
            if (mapping?.pendingThreadPrefix && Date.now() >= nextLookup) {
                nextLookup = Date.now() + 1000;
                const id = threadForPrefix(home, mapping.pendingThreadPrefix);
                if (id) {
                    mapping = { threadId: id };
                    file.write(mapping);
                }
            }
        };
    }

    private async resolveThread(config: HarnessConfig, launch: SessionLaunch): Promise<string> {
        if (!/^[a-zA-Z0-9_-]+$/.test(launch.sessionId)) throw new Error('Invalid Consola session ID.');
        const env = this.composeEnv(config, getLoginEnv());
        const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
        const filePath = path.join(home, 'consola', 'sessions', `${launch.sessionId}.json`);
        const file = new JsonStateFile<CodexMapping>(filePath);
        const stored = file.read();
        if (stored) {
            if (stored.pendingThreadPrefix) {
                const id = /^[0-9a-f-]{29}$/i.test(stored.pendingThreadPrefix)
                    ? threadForPrefix(home, stored.pendingThreadPrefix) : undefined;
                if (!id) throw new Error('Could not uniquely locate the active Codex conversation. Resume it in Codex before reopening this tab.');
                file.write({ threadId: id });
                return id;
            }
            if (typeof stored.threadId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(stored.threadId)) {
                throw new Error('Invalid saved Codex conversation ID.');
            }
            return stored.threadId;
        }
        // hasStarted may already be persisted before the first async launch finishes.
        // Only an absent mapping allows creation; a failed resume never replaces it.
        let pending = this.preparing.get(filePath);
        if (!pending) {
            pending = (async () => {
                if (!launch.cwd) throw new Error('Codex needs a working directory.');
                fs.mkdirSync(home, { recursive: true });
                const id = await createCodexThread(
                    this.resolveBinary(config), launch.cwd, env, `Consola ${launch.sessionId}`
                );
                file.write({ threadId: id });
                return id;
            })();
            this.preparing.set(filePath, pending);
        }
        try { return await pending; }
        finally { this.preparing.delete(filePath); }
    }

    public async probeCapabilities(config: HarnessConfig): Promise<HarnessCapabilities> {
        const models = await listCodexModels(
            this.resolveBinary(config), os.homedir(),
            this.composeEnv(config, getLoginEnv()), config.extraArgs
        );
        return { commands: [], agents: [], outputStyles: [], models };
    }

    public async probeHealth(config: HarnessConfig): Promise<HarnessProbeResult> {
        const resolvedBinary = this.resolveBinary(config);
        if (config.binaryPath && !isExecutable(config.binaryPath)) {
            return { available: false, resolvedBinary, error: `Not executable: ${config.binaryPath}` };
        }
        const run = (args: string[]) => new Promise<{ ok: boolean; output: string; code?: string }>(resolve => {
            execFile(resolvedBinary, args, {
                cwd: os.homedir(), env: this.composeEnv(config, getLoginEnv()), timeout: 10000,
                maxBuffer: 1024 * 1024,
            }, (error, stdout, stderr) => resolve({
                ok: !error, output: stdout + stderr, code: error ? String(error.code) : undefined,
            }));
        });
        const version = await run(['--version']);
        if (!version.ok) return {
            available: false, resolvedBinary,
            error: version.code === 'ENOENT'
                ? 'Not found — `codex` is not installed or not on PATH.'
                : 'Could not run Codex. Check the binary path and profile configuration.',
        };
        const login = await run(['login', 'status']);
        // Do not return raw login output: API-key login can include a key fragment.
        const displayName = /ChatGPT/i.test(login.output) ? 'ChatGPT'
            : /API key/i.test(login.output) ? 'API key' : 'Codex';
        return {
            available: true, resolvedBinary,
            version: version.output.match(/codex(?:-cli)?\s+(\S+)/)?.[1],
            account: login.ok ? { displayName } : undefined,
        };
    }
}
