/**
 * The process `claude` spawns for the `consola` MCP server: a dumb pipe
 * between its stdio and the Consola main process's per-conductor socket.
 *
 * Runs under `ELECTRON_RUN_AS_NODE=1`, so this is plain Node — no Electron
 * APIs, no imports beyond `net`. All intelligence lives in
 * ConductorControlServer on the other end of the socket; keeping this dumb
 * means the security boundary has exactly one implementation.
 */
import * as net from 'net';

const socketPath = process.env.CONSOLA_CONDUCTOR_SOCKET;
const token = process.env.CONSOLA_CONDUCTOR_TOKEN;

if (!socketPath || !token) {
    process.stderr.write('consola conductor shim: missing CONSOLA_CONDUCTOR_SOCKET or _TOKEN\n');
    process.exit(1);
}

const socket = net.connect(socketPath);

socket.once('connect', () => {
    // Handshake first; everything after is the CLI's own JSON-RPC.
    socket.write(JSON.stringify({ token }) + '\n');
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
});

socket.on('close', () => process.exit(0));
socket.on('error', (error) => {
    process.stderr.write(`consola conductor shim: ${error.message}\n`);
    process.exit(1);
});
process.stdin.on('end', () => process.exit(0));
