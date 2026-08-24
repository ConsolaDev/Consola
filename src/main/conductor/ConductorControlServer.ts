import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import {
    generateId,
    type NewSessionFields,
    type Session,
    type Workspace,
} from '../../shared/workspace';

/**
 * The control surface a conductor session drives Consola with.
 *
 * One endpoint per conductor: a private Unix socket plus a generated
 * `--mcp-config` file that has the CLI spawn `conductorShim.ts`, a dumb pipe
 * between its stdio and our socket. The tool logic runs here, in the main
 * process, next to the session records and terminals it acts on.
 *
 * Security boundary: a tool call is authenticated by which conductor's socket
 * it arrived on — the socket path and handshake token exist only in that
 * conductor's config file. Scope of authority is that conductor's group,
 * resolved fresh from the records on every call, never trusted from
 * arguments. Tokens never appear in tool results.
 */

export type ConductorSessionStatus = 'working' | 'ready' | 'needs-attention' | 'exited';

export interface ConductorControlDeps {
    getWorkspaces(): Workspace[];
    launchSession(
        workspaceId: string,
        fields: NewSessionFields & { initialPrompt?: string }
    ): Promise<Session>;
    /** Enqueue on the session's guarded FIFO. False when no live terminal. */
    queuePrompt(instanceId: string, prompt: string): boolean;
    getStatus(instanceId: string): ConductorSessionStatus;
    /** Absolute path to the compiled stdio shim the CLI will spawn. */
    shimEntryPath(): string;
    /** Directory for per-session MCP config files. Created on demand. */
    configDir(): string;
}

interface Endpoint {
    socketPath: string;
    token: string;
    configPath: string;
    server: net.Server;
    /** Live client connections, so unregister can sever them, not just stop listening. */
    sockets: Set<net.Socket>;
}

/** Longest a client may stall mid-handshake before the line is cut. */
const HANDSHAKE_LIMIT_BYTES = 4096;

export class ConductorControlServer {
    private readonly endpoints = new Map<string, Endpoint>();
    /**
     * In-flight `register()` calls, keyed by session id.
     *
     * `register` is `async`, so the gap between reading `endpoints` and
     * writing it spans several awaits (socket listen, mkdir, writeFile). Two
     * overlapping callers — the headless launch and a pane mount racing each
     * other — would otherwise both pass the "already registered" check, each
     * open its own listening socket, and leave one of them behind with
     * nothing in `endpoints` to ever unregister it. Memoizing the promise
     * closes that window: a second caller before the first settles gets the
     * same promise, not a second endpoint.
     */
    private readonly pendingRegistrations = new Map<string, Promise<string>>();

    constructor(private readonly deps: ConductorControlDeps) {}

    /**
     * Ensure this conductor has a live endpoint; returns its config path.
     *
     * Idempotent because both launch paths call it: the headless spawn at
     * creation, and TERMINAL_CREATE when a pane mounts after an app restart.
     * The config references this run's socket, so it is rewritten per run.
     */
    public async register(session: Session): Promise<string> {
        if (session.kind !== 'conductor') {
            throw new Error(
                `Session ${session.id} is not a conductor; refusing to register control tools.`
            );
        }

        const existing = this.endpoints.get(session.id);
        if (existing) return existing.configPath;

        const pending = this.pendingRegistrations.get(session.id);
        if (pending) return pending;

        const promise = this.createEndpoint(session).finally(() => {
            this.pendingRegistrations.delete(session.id);
        });
        this.pendingRegistrations.set(session.id, promise);
        return promise;
    }

    /** The actual registration work, run at most once concurrently per session id. */
    private async createEndpoint(session: Session): Promise<string> {
        const token = crypto.randomBytes(16).toString('hex');
        const socketPath = newSocketPath();
        const server = net.createServer((socket) => this.handleConnection(session.id, socket));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(socketPath, () => resolve());
        });

        const configPath = path.join(this.deps.configDir(), `${session.id}.json`);
        const config = {
            mcpServers: {
                consola: {
                    type: 'stdio',
                    command: process.execPath,
                    args: [this.deps.shimEntryPath()],
                    env: {
                        // Turns the Electron binary into plain Node for the
                        // shim — no system Node install is assumed.
                        ELECTRON_RUN_AS_NODE: '1',
                        CONSOLA_CONDUCTOR_SOCKET: socketPath,
                        CONSOLA_CONDUCTOR_TOKEN: token,
                    },
                },
            },
        };
        await fs.promises.mkdir(this.deps.configDir(), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), {
            mode: 0o600,
        });

        this.endpoints.set(session.id, { socketPath, token, configPath, server, sockets: new Set() });
        return configPath;
    }

    /** Close a conductor's endpoint, sever any live connections, and remove its socket and config file. */
    public unregister(sessionId: string): void {
        const endpoint = this.endpoints.get(sessionId);
        if (!endpoint) return;
        this.endpoints.delete(sessionId);
        endpoint.server.close();
        // close() only stops accepting new connections; an already-connected
        // shim would otherwise keep a working, now-unaccounted-for channel.
        for (const socket of endpoint.sockets) {
            socket.destroy();
        }
        for (const doomed of [endpoint.socketPath, endpoint.configPath]) {
            try {
                fs.unlinkSync(doomed);
            } catch {
                // Already gone, or a Windows named pipe with no file to unlink.
            }
        }
    }

    public dispose(): void {
        for (const sessionId of [...this.endpoints.keys()]) {
            this.unregister(sessionId);
        }
    }

    /**
     * First line on a new connection is a handshake `{"token": "..."}\n`;
     * everything after is JSON-RPC handed to a fresh MCP server instance.
     * A wrong token gets a closed socket and nothing else.
     */
    private handleConnection(conductorSessionId: string, socket: net.Socket): void {
        const endpoint = this.endpoints.get(conductorSessionId);
        if (!endpoint) {
            socket.destroy();
            return;
        }
        endpoint.sockets.add(socket);
        socket.once('close', () => endpoint.sockets.delete(socket));

        let buffer = '';
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const newline = buffer.indexOf('\n');
            if (newline === -1) {
                if (buffer.length > HANDSHAKE_LIMIT_BYTES) socket.destroy();
                return;
            }
            socket.off('data', onData);

            let authenticated = false;
            try {
                authenticated = JSON.parse(buffer.slice(0, newline)).token === endpoint.token;
            } catch {
                // Not even JSON: treated the same as a wrong token.
            }
            if (!authenticated) {
                socket.destroy();
                return;
            }

            // Bytes that arrived glued to the handshake belong to the
            // JSON-RPC stream; push them back for the transport to read.
            const rest = buffer.slice(newline + 1);
            if (rest.length > 0) socket.unshift(Buffer.from(rest, 'utf8'));

            const transport = new StdioServerTransport(socket, socket);
            // buildServerFor throws synchronously today (Task 6 stub) and
            // connect() can reject once it is real; either would otherwise
            // escape this event handler as an uncaught exception / unhandled
            // rejection and take down the main process over one bad socket.
            try {
                this.buildServerFor(conductorSessionId)
                    .connect(transport)
                    .catch(() => socket.destroy());
            } catch {
                socket.destroy();
            }
        };
        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    }

    /**
     * The MCP surface for one conductor. Implemented in Task 6; the stub
     * keeps Task 4 compiling and failing honestly if reached.
     */
    public buildServerFor(conductorSessionId: string): McpServer {
        void conductorSessionId;
        throw new Error('buildServerFor is implemented in Task 6.');
    }

    /**
     * Who is calling, resolved fresh from the records on every tool call.
     *
     * The id comes from the endpoint the request arrived on, so this cannot
     * be spoofed by arguments; re-resolving means a deleted conductor or a
     * changed group takes effect immediately.
     */
    private resolveConductor(conductorSessionId: string): {
        workspace: Workspace;
        conductor: Session;
        groupId: string;
    } {
        for (const workspace of this.deps.getWorkspaces()) {
            const conductor = workspace.sessions.find((s) => s.id === conductorSessionId);
            if (!conductor) continue;
            if (conductor.kind !== 'conductor') {
                throw new Error('Calling session is not a conductor.');
            }
            if (!conductor.groupId) {
                throw new Error('Conductor has no group; nothing to act on.');
            }
            return { workspace, conductor, groupId: conductor.groupId };
        }
        throw new Error('Conductor session no longer exists.');
    }

    private groupMembers(workspace: Workspace, groupId: string): Session[] {
        return workspace.sessions.filter((s) => s.groupId === groupId);
    }

    public async handleSpawnSession(
        conductorSessionId: string,
        args: { name: string; scopePath?: string; cwd?: string; prompt: string }
    ): Promise<{ sessionId: string; instanceId: string }> {
        const { workspace, conductor, groupId } = this.resolveConductor(conductorSessionId);

        const scope = args.scopePath
            ? workspace.scopes.find((s) => path.resolve(s.path) === path.resolve(args.scopePath!))
            : workspace.scopes.find((s) => s.id === conductor.scopeId);
        if (!scope) {
            throw new Error(
                `scopePath is not one of this workspace's scopes: ${args.scopePath ?? '(conductor scope missing)'}`
            );
        }

        if (args.cwd) {
            const relative = path.relative(path.resolve(scope.path), path.resolve(args.cwd));
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`cwd must be inside the scope ${scope.path}`);
            }
        }

        // groupId and kind come from the calling conductor's record, never
        // from arguments: a conductor cannot spawn outside its own group, and
        // cannot mint further conductors. Workers inherit its harness so the
        // whole group runs as one login.
        const spawned = await this.deps.launchSession(workspace.id, {
            name: args.name,
            workspaceId: workspace.id,
            instanceId: generateId(),
            harnessId: conductor.harnessId,
            scopeId: scope.id,
            cwd: args.cwd,
            groupId,
            kind: 'interactive',
            initialPrompt: args.prompt,
        } as NewSessionFields & { initialPrompt?: string });

        return { sessionId: spawned.id, instanceId: spawned.instanceId };
    }

    public handleSendPrompt(
        conductorSessionId: string,
        args: { sessionId: string; prompt: string }
    ): { queued: true } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);

        if (!this.deps.queuePrompt(target.instanceId, args.prompt)) {
            throw new Error(`Session ${args.sessionId} has no live terminal; prompt not delivered.`);
        }
        return { queued: true };
    }

    public handleSessionStatus(
        conductorSessionId: string,
        args: { sessionId: string }
    ): { status: ConductorSessionStatus; name: string } {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        const target = this.groupMembers(workspace, groupId).find((s) => s.id === args.sessionId);
        if (!target) throw new Error(`Session ${args.sessionId} is not in your group.`);
        return { status: this.deps.getStatus(target.instanceId), name: target.name };
    }

    public handleGroupStatus(
        conductorSessionId: string
    ): Array<{ sessionId: string; name: string; status: ConductorSessionStatus }> {
        const { workspace, groupId } = this.resolveConductor(conductorSessionId);
        return this.groupMembers(workspace, groupId).map((member) => ({
            sessionId: member.id,
            name: member.name,
            status: this.deps.getStatus(member.instanceId),
        }));
    }
}

/**
 * A fresh, unguessable rendezvous path. Random per registration, so a stale
 * file from a crash can never collide, and knowing one run's path buys
 * nothing in the next.
 */
function newSocketPath(): string {
    const suffix = crypto.randomBytes(8).toString('hex');
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\consola-conductor-${suffix}`
        : path.join(os.tmpdir(), `consola-conductor-${suffix}.sock`);
}

/**
 * The kind gate both launch paths share: conductors get a config path,
 * everything else gets nothing. One implementation, so "interactive sessions
 * never carry MCP registration" is a single tested fact.
 */
export async function mcpConfigForSession(
    session: Session,
    control: { register(session: Session): Promise<string> }
): Promise<string | undefined> {
    return session.kind === 'conductor' ? control.register(session) : undefined;
}
