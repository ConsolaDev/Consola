// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - It reads factory-spec's fixture, hashes as the runner does, and lets the ring's promises run.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactoryFile, FactorySnapshot, RunRecord } from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import { createAutomationsRing } from '../core/automations/ring.ts';
import { makeCellLink, sayAgainOnGreeting } from './cellLink.ts';
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

  it('says every run’s record again before any request on a new socket: the cell answers a token by the run it holds', async () => {
    const fixture = fileURLToPath(
      new URL('../../../factory-spec/src/fixtures/review-pull-requests', import.meta.url),
    );
    const filesIn = (prefix = ''): FactoryFile[] =>
      readdirSync(join(fixture, prefix), { withFileTypes: true }).flatMap((entry) => {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        return entry.isDirectory()
          ? filesIn(path)
          : [{ path, content: readFileSync(join(fixture, path), 'utf8') }];
      });
    const review: FactorySnapshot = { factoryId: 'factory-sprocket', version: 3, files: filesIn() };
    const { link, sent, socket } = linkOver();
    let ms = Date.parse('2026-11-25T10:00:00.000Z');
    const never = () => new Promise<never>(() => undefined);
    const ring = createAutomationsRing({
      link,
      agentSteps: { run: never },
      commandSteps: { run: never },
      now: () => new Date(ms++).toISOString(),
      digest: (text) => createHash('sha256').update(text, 'utf8').digest('hex'),
      log: () => undefined,
    });
    const settle = () => new Promise((done) => setTimeout(done, 10));
    const answerFactories = (requestId: string) =>
      link.answer({ type: 'factories', requestId, factories: [review] });

    ring.receive({
      type: 'github.event',
      deliveryId: 'd0c5-0001',
      event: {
        name: 'pull_request',
        action: 'opened',
        repository: 'sprocket/catalog-portal',
        number: 42,
        url: 'https://github.com/sprocket/catalog-portal/pull/42',
        title: 'Add a retry to the catalog sync',
        author: 'JaviDev',
        draft: false,
        headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        headRef: 'fix/catalog-retry',
        baseRef: 'main',
        fork: false,
      },
    });
    answerFactories('request-1');
    await settle();
    const waiting = sent.find(
      (message): message is { type: 'run.record'; run: RunRecord } => message.type === 'run.record',
    )?.run;
    expect(waiting?.status).toBe('needs-approval');
    if (waiting === undefined) return;

    // Approved; the socket drops as the run's factory comes back, so the run's `running` record
    // and its first step's token request are lost with it.
    ring.receive({ type: 'run.answered', run: waiting, decision: 'approved', personId: 'p-1' });
    socket.up = false;
    answerFactories('request-2');
    await settle();

    socket.up = true;
    sent.length = 0;
    sayAgainOnGreeting(ring, link);
    const types = sent.map((message) => message.type);
    expect(types[0]).toBe('run.record');
    expect(types.at(-1)).toBe('github.token.request');
    const record = sent[0]?.type === 'run.record' ? sent[0].run : null;
    expect(record).toMatchObject({ id: waiting.id, status: 'running' });

    ring.stop();
    link.close();
    await ring.settled();
  });
});
