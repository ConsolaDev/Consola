import { describe, expect, it, vi } from 'vitest';
import type { HarnessConfig, HarnessDriver } from '../drivers';
import type { McpServerReport } from '../drivers/HarnessDriver';
import { McpServersCache } from './mcpServersCache';

/*
 * The servers cache (Calls 5 and 6): one probe per harness identity for the
 * app's life, a failure kept until Check again, one more probe per name an
 * agent names that the answer lacks, and the settled answer kept while that
 * probe runs (review M1). Each probe here is a promise the test settles by hand.
 */

const report = (...names: string[]): McpServerReport[] =>
  names.map((name) => ({ name, source: 'user', transport: 'stdio', status: 'connected' }));

/** A driver whose every `probeMcpServers` call waits for the test to settle it. */
function fakeDriver(id = 'claude') {
  const probes: Array<{
    config: HarnessConfig;
    resolve(servers: McpServerReport[]): void;
    reject(error: Error): void;
  }> = [];
  const driver = {
    id,
    probeMcpServers: (config: HarnessConfig) =>
      new Promise<McpServerReport[]>((resolve, reject) => probes.push({ config, resolve, reject })),
  } as unknown as HarnessDriver;
  return { driver, probes };
}

const WORK: HarnessConfig = { configDir: '/home/alice/.claude-work', extraArgs: [] };
const PERSONAL: HarnessConfig = { configDir: '/home/alice/.claude-personal', extraArgs: [] };

/** Lets every settled probe's handlers run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function cache() {
  const onSettled = vi.fn();
  return { cache: new McpServersCache({ onSettled }), onSettled };
}

describe('McpServersCache', () => {
  it('starts one probe on the first ask, answers pending meanwhile, then the report', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    expect(servers.ask(driver, WORK)).toEqual({ state: 'pending' });
    expect(servers.ask(driver, WORK)).toEqual({ state: 'pending' });
    expect(probes).toHaveLength(1);
    expect(probes[0].config).toBe(WORK);
    probes[0].resolve(report('grafana'));
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(servers.ask(driver, WORK)).toEqual({ state: 'settled', servers: report('grafana') });
    expect(probes).toHaveLength(1);
  });

  it('keeps a failure, and asks nothing more of its own', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    servers.ask(driver, WORK);
    probes[0].reject(new Error('spawn claude ENOENT'));
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(servers.ask(driver, WORK)).toEqual({ state: 'failed', error: 'spawn claude ENOENT' });
    servers.ask(driver, WORK);
    servers.missing(driver, WORK, ['grafana']);
    expect(probes).toHaveLength(1);
  });

  it('get: waits for a probe under way, starts one when there is none, and rejects with a failure', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers } = cache();
    servers.ask(driver, WORK);
    const waiting = servers.get(driver, WORK);
    probes[0].resolve(report('grafana'));
    await expect(waiting).resolves.toEqual(report('grafana'));
    expect(probes).toHaveLength(1);

    const started = servers.get(driver, PERSONAL);
    expect(probes).toHaveLength(2);
    probes[1].reject(new Error('No answer from `claude` within 30000ms.'));
    await expect(started).rejects.toThrow('No answer from `claude` within 30000ms.');
    await settle();
    await expect(servers.get(driver, PERSONAL)).rejects.toThrow(
      'No answer from `claude` within 30000ms.',
    );
    expect(probes).toHaveLength(2);
  });

  it('probes once more for each name the settled report lacks, keeping that report meanwhile (M1)', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    servers.ask(driver, WORK);
    probes[0].resolve(report('grafana'));
    await settle();

    servers.missing(driver, WORK, ['grafanna']);
    expect(probes).toHaveLength(2);
    expect(servers.ask(driver, WORK)).toEqual({ state: 'settled', servers: report('grafana') });
    probes[1].resolve(report('grafana', 'tracker-old'));
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(servers.ask(driver, WORK)).toEqual({
      state: 'settled',
      servers: report('grafana', 'tracker-old'),
    });

    servers.missing(driver, WORK, ['grafanna']);
    expect(probes).toHaveLength(2);
    servers.missing(driver, WORK, ['grafanna', 'tracker']);
    expect(probes).toHaveLength(3);
  });

  it('a name named while such a probe runs is asked by it, not by one more', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers } = cache();
    servers.ask(driver, WORK);
    probes[0].resolve(report('grafana'));
    await settle();
    servers.missing(driver, WORK, ['grafanna']);
    servers.missing(driver, WORK, ['tracker']);
    expect(probes).toHaveLength(2);
    probes[1].resolve(report('grafana'));
    await settle();
    servers.missing(driver, WORK, ['tracker']);
    expect(probes).toHaveLength(2);
  });

  it('a launch waits for that probe, and gets its report', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers } = cache();
    servers.ask(driver, WORK);
    probes[0].resolve(report('grafana'));
    await settle();
    servers.missing(driver, WORK, ['tracker']);
    const launch = servers.get(driver, WORK);
    probes[1].resolve(report('grafana', 'tracker'));
    await expect(launch).resolves.toEqual(report('grafana', 'tracker'));
  });

  it('a probe for a missing name that fails keeps the settled report (M1)', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    servers.ask(driver, WORK);
    probes[0].resolve(report('grafana'));
    await settle();
    servers.missing(driver, WORK, ['grafanna']);
    const launch = servers.get(driver, WORK);
    probes[1].reject(new Error('spawn claude ENOENT'));
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(servers.ask(driver, WORK)).toEqual({ state: 'settled', servers: report('grafana') });
    await expect(launch).resolves.toEqual(report('grafana'));
  });

  it('Check again forgets every answer; its probe counts the names asked about before as asked (M13)', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    servers.ask(driver, WORK);
    probes[0].reject(new Error('spawn claude ENOENT'));
    await settle();
    servers.refresh();
    expect(servers.peek(driver, WORK)).toBeUndefined();
    expect(servers.ask(driver, WORK)).toEqual({ state: 'pending' });
    expect(probes).toHaveLength(2);
    probes[1].resolve(report('grafana'));
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(2);
    servers.missing(driver, WORK, ['grafanna']);
    expect(probes).toHaveLength(3);
    probes[2].resolve(report('grafana'));
    await settle();

    // Check again once more: `grafanna` was asked about, and its probe is Check again's own.
    servers.refresh();
    servers.ask(driver, WORK);
    expect(probes).toHaveLength(4);
    probes[3].resolve(report('grafana'));
    await settle();
    servers.missing(driver, WORK, ['grafanna']);
    expect(probes).toHaveLength(4);
    // A name nobody asked about before gets its one more probe.
    servers.missing(driver, WORK, ['tracker2']);
    expect(probes).toHaveLength(5);
  });

  it('an answer to a probe started before Check again is not kept', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers, onSettled } = cache();
    servers.ask(driver, WORK);
    servers.refresh();
    servers.ask(driver, WORK);
    expect(probes).toHaveLength(2);
    probes[0].resolve(report('stale'));
    await settle();
    expect(servers.ask(driver, WORK)).toEqual({ state: 'pending' });
    expect(onSettled).not.toHaveBeenCalled();
    probes[1].resolve(report('grafana'));
    await settle();
    expect(servers.ask(driver, WORK)).toEqual({ state: 'settled', servers: report('grafana') });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps each harness identity apart', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers } = cache();
    servers.ask(driver, WORK);
    servers.ask(driver, PERSONAL);
    servers.ask(driver, { ...WORK, extraArgs: ['--verbose'] });
    servers.ask(driver, { ...WORK, binaryPath: '/opt/claude' });
    expect(probes.map((probe) => probe.config)).toEqual([
      WORK,
      PERSONAL,
      { ...WORK, extraArgs: ['--verbose'] },
      { ...WORK, binaryPath: '/opt/claude' },
    ]);
    probes[1].resolve(report('tracker'));
    await settle();
    expect(servers.ask(driver, WORK)).toEqual({ state: 'pending' });
    expect(servers.ask(driver, PERSONAL)).toEqual({ state: 'settled', servers: report('tracker') });
  });

  it('peek answers what it holds and starts nothing', async () => {
    const { driver, probes } = fakeDriver();
    const { cache: servers } = cache();
    expect(servers.peek(driver, WORK)).toBeUndefined();
    expect(probes).toHaveLength(0);
    servers.ask(driver, WORK);
    expect(servers.peek(driver, WORK)).toEqual({ state: 'pending' });
    probes[0].resolve(report('grafana'));
    await settle();
    expect(servers.peek(driver, WORK)).toEqual({ state: 'settled', servers: report('grafana') });
    expect(probes).toHaveLength(1);
  });

  it('a driver that cannot list its servers fails at once, and says so', async () => {
    const { cache: servers, onSettled } = cache();
    const codex = { id: 'codex' } as unknown as HarnessDriver;
    const answer = { state: 'failed', error: 'codex cannot list its MCP servers.' };
    expect(servers.ask(codex, WORK)).toEqual(answer);
    // Told once, and never from inside the ask.
    expect(onSettled).not.toHaveBeenCalled();
    expect(servers.peek(codex, WORK)).toEqual(answer);
    await expect(servers.get(codex, WORK)).rejects.toThrow('codex cannot list its MCP servers.');
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});
