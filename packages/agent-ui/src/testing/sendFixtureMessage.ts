/**
 * Sends the `simple` fixture's first message to a replay host through t3's own RPC client, as
 * t3's chat sends it, and exits once the host has taken it. `hostSession.ts` starts it with node,
 * on the tests' isolated machine:
 *
 *   node src/testing/sendFixtureMessage.ts <port> <pass> <session id>
 */
import { connectHost } from '@consola/host/src/testing/t3Client.ts';
import { loadReplay, sendMessage } from '@consola/host/src/testing/replay.ts';
import { ORCHESTRATION_V2_WS_METHODS } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';

const [port = '', pass = '', sessionId = ''] = process.argv.slice(2);

const send = Effect.gen(function* () {
  const { variant, text } = yield* loadReplay('simple');
  // As t3's client connects: a socket ticket for the pass, then the socket it opens.
  const { client } = yield* connectHost(Number(port), pass);
  yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
    sendMessage({ sessionId, harness: 'claude', cwd: '' }, text, variant.modelSelection),
  );
}).pipe(Effect.scoped);

try {
  await Effect.runPromise(send);
} catch (error: unknown) {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
}
process.exit(0);
