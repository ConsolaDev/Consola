import type { FactorySnapshot } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import { makeCellLink } from './cellLink.ts';
import type { RunMessage } from './cellSocket.ts';

const FACTORY: FactorySnapshot = {
  factoryId: 'factory-sprocket',
  version: 3,
  files: [{ path: 'factory.yml', content: 'version: 1\n' }],
};

/** A link over a socket that is up while `up` says so, keeping what went on it. */
function linkOver(options: { timeoutMs?: number } = {}) {
  const sent: RunMessage[] = [];
  const logged: string[] = [];
  const socket = { up: true };
  let next = 0;
  const link = makeCellLink({
    sendNow: (message) => {
      if (!socket.up) return false;
      sent.push(message);
      return true;
    },
    log: (line) => logged.push(line),
    requestId: () => `request-${++next}`,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { link, sent, logged, socket };
}

describe('makeCellLink', () => {
  it('asks for the factories, or one at one version, and hands back the answer naming it', async () => {
    const { link, sent } = linkOver();
    const all = link.factories();
    const one = link.factories({ factoryId: 'factory-sprocket', version: 3 });
    expect(sent).toEqual([
      { type: 'factories.request', requestId: 'request-1' },
      {
        type: 'factories.request',
        requestId: 'request-2',
        only: { factoryId: 'factory-sprocket', version: 3 },
      },
    ]);
    link.answer({ type: 'factories', requestId: 'request-2', factories: [FACTORY] });
    link.answer({ type: 'factories', requestId: 'request-1', factories: [] });
    expect(await one).toEqual([FACTORY]);
    expect(await all).toEqual([]);
  });

  it('asks for a step’s token, and hands back the token or the cell’s reason', async () => {
    const { link, sent } = linkOver();
    const request = {
      runId: 'run-1',
      stepId: 'post',
      repository: 'sprocket/catalog-portal',
      permissions: { pull_requests: 'write' as const },
    };
    const given = link.token(request);
    const refused = link.token(request);
    expect(sent).toEqual([
      { type: 'github.token.request', requestId: 'request-1', ...request },
      { type: 'github.token.request', requestId: 'request-2', ...request },
    ]);
    link.answer({
      type: 'github.token',
      requestId: 'request-1',
      token: 'ghs_sprocket0123456789',
      expiresAt: '2026-11-25T11:00:00.000Z',
    });
    link.answer({ type: 'github.token.refused', requestId: 'request-2', reason: 'Not allowed.' });
    expect(await given).toEqual({ ok: true, token: 'ghs_sprocket0123456789' });
    expect(await refused).toEqual({ ok: false, reason: 'Not allowed.' });
  });

  it('asks again on a new socket a request the last one never answered, and none answered already', async () => {
    const { link, sent, socket } = linkOver();
    socket.up = false;
    const waiting = link.factories();
    const answered = link.factories();
    expect(sent).toEqual([]);
    socket.up = true;
    link.connected();
    expect(sent.map((message) => 'requestId' in message && message.requestId)).toEqual([
      'request-1',
      'request-2',
    ]);
    link.answer({ type: 'factories', requestId: 'request-2', factories: [] });
    await answered;
    link.connected();
    expect(sent.map((message) => 'requestId' in message && message.requestId)).toEqual([
      'request-1',
      'request-2',
      'request-1',
    ]);
    link.answer({ type: 'factories', requestId: 'request-1', factories: [FACTORY] });
    expect(await waiting).toEqual([FACTORY]);
  });

  it('fails a request the cell does not answer in time, and drops an answer it no longer waits on', async () => {
    const { link, logged } = linkOver({ timeoutMs: 20 });
    await expect(link.factories()).rejects.toThrow('The cell did not answer within 0 s.');
    link.answer({ type: 'factories', requestId: 'request-1', factories: [] });
    expect(logged).toEqual([
      'the cell answered request request-1, which this runner is not waiting on; dropped',
    ]);
  });

  it('fails an answer of the wrong kind, and every request still waiting once it closes', async () => {
    const { link } = linkOver();
    const factories = link.factories();
    link.answer({
      type: 'github.token',
      requestId: 'request-1',
      token: 'ghs_sprocket0123456789',
      expiresAt: '2026-11-25T11:00:00.000Z',
    });
    await expect(factories).rejects.toThrow('The cell answered a factories request with a token.');
    const token = link.token({
      runId: 'run-1',
      stepId: 'post',
      repository: 'sprocket/catalog-portal',
      permissions: { contents: 'read' },
    });
    link.close();
    await expect(token).rejects.toThrow('The runner is stopping.');
    await expect(link.factories()).rejects.toThrow('The runner is stopping.');
  });

  it('says a record or an acknowledgement at once, and says whether it went', () => {
    const { link, sent, socket } = linkOver();
    expect(link.send({ type: 'github.event.ack', deliveryId: 'd0c5-1' })).toBe(true);
    socket.up = false;
    expect(link.send({ type: 'github.event.ack', deliveryId: 'd0c5-2' })).toBe(false);
    expect(sent).toEqual([{ type: 'github.event.ack', deliveryId: 'd0c5-1' }]);
  });
});
