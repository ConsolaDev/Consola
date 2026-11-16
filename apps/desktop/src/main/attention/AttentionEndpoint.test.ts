import * as http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttentionEndpoint, MAX_BODY_BYTES } from './AttentionEndpoint';
import type { AttentionSignal } from './hookSignals';

const SIGNAL: AttentionSignal = { kind: 'needs-input', origin: 'menu' };
let endpoint: AttentionEndpoint | undefined;
afterEach(() => {
  endpoint?.close();
  endpoint = undefined;
});

async function setup() {
  const heard: Array<[string, AttentionSignal]> = [];
  endpoint = new AttentionEndpoint((instanceId, signal) => heard.push([instanceId, signal]));
  const url = (await endpoint.urlFor('inst-a', (body) => (body ? SIGNAL : null)))!;
  return { heard, url };
}

const post = (url: string, body: unknown = { hook_event_name: 'Notification' }) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('AttentionEndpoint', () => {
  it('binds loopback only', async () => {
    const { url } = await setup();
    expect(new URL(url).hostname).toBe('127.0.0.1');
  });

  it('hands a valid post to the signal sink, tagged with the terminal that owns the token', async () => {
    const { heard, url } = await setup();
    const res = await post(url);
    expect(res.status).toBe(200);
    expect(heard).toEqual([['inst-a', SIGNAL]]);
  });

  it('rejects a request with no token or a wrong one, and hears nothing', async () => {
    const { heard, url } = await setup();
    const base = new URL(url).origin;
    const wrong = `${base}/attention/${'0'.repeat(48)}`;
    for (const bad of [`${base}/attention/`, `${base}/attention`, `${base}/`, wrong, `${wrong}/extra`, `${url}x`]) {
      expect((await post(bad)).status).toBe(401);
    }
    expect(heard).toEqual([]);
  });

  it('rejects other methods', async () => {
    const { url } = await setup();
    expect((await fetch(url)).status).toBe(405);
  });

  it('gives each terminal its own token, and a closed terminal’s token stops working', async () => {
    const { url } = await setup();
    const other = (await endpoint!.urlFor('inst-b', () => null))!;
    expect(other).not.toBe(url);
    expect(await endpoint!.urlFor('inst-a', () => null)).toBe(url);
    endpoint!.unregister('inst-a');
    expect((await post(url)).status).toBe(401);
    expect((await post(other)).status).toBe(200);
  });

  it('answers at once and survives an unreadable body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { heard, url } = await setup();
    const res = await fetch(url, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(200);
    expect(heard).toEqual([]);
    expect((await post(url)).status).toBe(200);
    expect(heard).toHaveLength(1);
    warn.mockRestore();
  });

  it('answers as soon as the token is valid, without waiting for the body', async () => {
    const { heard, url } = await setup();
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    // The hook's body is still open here: a CLI that streams one slowly, or
    // one that stalls, must not be waiting on this process.
    req.write('{"hook_event_name":');
    const status = await new Promise<number>((resolve, reject) => {
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
    });
    expect(status).toBe(200);

    req.end('"Notification"}');
    await vi.waitFor(() => expect(heard).toEqual([['inst-a', SIGNAL]]));
  });

  it('answers 200 for a body too large to be a hook event, and only drops the signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { heard, url } = await setup();

    const res = await fetch(url, { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1024) });

    // Never a non-2xx: the CLI would report a failing hook Consola injected,
    // in the person's own transcript, over a signal only Consola wanted.
    expect(res.status).toBe(200);
    expect(heard).toEqual([]);
    // And the endpoint keeps working afterwards.
    expect((await post(url)).status).toBe(200);
    expect(heard).toHaveLength(1);
    warn.mockRestore();
  });

  it('takes a large-but-plausible payload, such as a tool_input over the old 256KB cap', async () => {
    const { heard, url } = await setup();

    const res = await post(url, { hook_event_name: 'PostToolUse', tool_input: { content: 'x'.repeat(400 * 1024) } });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(heard).toHaveLength(1));
  });
});
