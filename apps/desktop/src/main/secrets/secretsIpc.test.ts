import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PERSONAL_FACTORY } from '@consola/automation-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/constants';
import { JsonStateFile } from '../state/JsonStateFile';
import { BindingsStore } from './BindingsStore';
import type { SecretBindingsFile } from './BindingsStore';
import { secretPrograms } from './programs';
import { REFERENCE_WORDS } from './references';
import { registerSecretsIpc, removeSecretsIpc, SECRETS_CHANNELS } from './secretsIpc';

/*
 * The handlers' own refusals and wiring (review M5), over a real bindings
 * file in a temp folder and a fake `ipc`. Nothing reads a value: no binding
 * here is ever resolved, and the programs are a test run's (none).
 */

const P = PERSONAL_FACTORY;
const ENV_REF = { kind: 'env', name: 'STUB_PAGER_TOKEN' } as const;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-secrets-ipc-'));
  file = path.join(dir, 'secret-bindings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Listener = (event: never, ...args: unknown[]) => unknown;

function wire(ids: string[] = ['ws-1', 'ws-2']) {
  const handlers = new Map<string, Listener>();
  const removed: string[] = [];
  const ipc = {
    handle: (channel: string, listener: Listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      removed.push(channel);
    },
  };
  const held = { ids };
  const changes: Array<() => void> = [];
  const workspaces = {
    getAll: () => held.ids.map((id) => ({ id })),
    onChange: (listener: () => void) => changes.push(listener),
  };
  const bindings = new BindingsStore(
    new JsonStateFile<SecretBindingsFile>(file),
    () => new Date('2026-11-23T08:00:00.000Z'),
  );
  const automations = {
    reload: vi.fn(async (_workspaceId: string) => {}),
    secretsView: vi.fn((_workspaceId: string) => []),
  };
  const loginEnv = vi.fn(async (): Promise<NodeJS.ProcessEnv> => ({ PATH: '/usr/bin:/bin' }));
  registerSecretsIpc({
    ipc: ipc as never,
    workspaces,
    bindings,
    runner: automations,
    secretDeps: { store: bindings, programs: secretPrograms({ test: true, env: {} }), loginEnv },
  });
  const call = (channel: string, ...args: unknown[]) =>
    Promise.resolve().then(() => handlers.get(channel)!({} as never, ...args));
  return { handlers, removed, ipc, held, changes, bindings, automations, loginEnv, call };
}

describe('Settings › Secrets channels', () => {
  it('handles exactly the three channels, and removes the three', () => {
    const { handlers, removed, ipc } = wire();
    expect([...handlers.keys()].sort()).toEqual([...SECRETS_CHANNELS].sort());
    expect([...SECRETS_CHANNELS].sort()).toEqual(
      [IPC_CHANNELS.SECRETS_LIST, IPC_CHANNELS.SECRETS_BIND, IPC_CHANNELS.SECRETS_UNBIND].sort(),
    );
    removeSecretsIpc(ipc as never);
    expect(removed.sort()).toEqual([...SECRETS_CHANNELS].sort());
  });

  it('refuses a workspace this Mac does not hold, or no id, before anything else (review M5)', async () => {
    const { call, bindings, automations, loginEnv } = wire();
    for (const workspaceId of ['ws-gone', 42, undefined]) {
      await expect(call(IPC_CHANNELS.SECRETS_LIST, workspaceId)).rejects.toThrow(
        'Unknown workspace.',
      );
      await expect(
        call(IPC_CHANNELS.SECRETS_BIND, workspaceId, 'PAGER_TOKEN', ENV_REF),
      ).rejects.toThrow('Unknown workspace.');
      await expect(call(IPC_CHANNELS.SECRETS_UNBIND, workspaceId, 'PAGER_TOKEN')).rejects.toThrow(
        'Unknown workspace.',
      );
    }
    expect(bindings.names('ws-gone', P)).toEqual([]);
    expect(automations.reload).not.toHaveBeenCalled();
    expect(automations.secretsView).not.toHaveBeenCalled();
    expect(loginEnv).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('refuses a bind or an unbind with no name, and binds nothing (review M5)', async () => {
    const { call, bindings, automations } = wire();
    bindings.bind('ws-1', P, 'PAGER_TOKEN', ENV_REF);
    for (const name of [42, undefined, null]) {
      await expect(call(IPC_CHANNELS.SECRETS_BIND, 'ws-1', name, ENV_REF)).rejects.toThrow(
        'Secret name required.',
      );
      await expect(call(IPC_CHANNELS.SECRETS_UNBIND, 'ws-1', name)).rejects.toThrow(
        'Secret name required.',
      );
    }
    expect(bindings.names('ws-1', P)).toEqual(['PAGER_TOKEN']);
    expect(automations.reload).not.toHaveBeenCalled();
  });

  it('refuses a reference that is not one of the three shapes', async () => {
    const { call, bindings, automations } = wire();
    await expect(
      call(IPC_CHANNELS.SECRETS_BIND, 'ws-1', 'PAGER_TOKEN', { kind: 'paste', value: 'x' }),
    ).rejects.toThrow(REFERENCE_WORDS);
    expect(bindings.names('ws-1', P)).toEqual([]);
    expect(automations.reload).not.toHaveBeenCalled();
  });

  it('binds and unbinds through the store, reloading that workspace each time', async () => {
    const { call, bindings, automations } = wire();
    await call(IPC_CHANNELS.SECRETS_BIND, 'ws-1', 'PAGER_TOKEN', ENV_REF);
    expect(bindings.get('ws-1', P, 'PAGER_TOKEN')?.ref).toEqual(ENV_REF);
    expect(automations.reload.mock.calls).toEqual([['ws-1']]);
    await call(IPC_CHANNELS.SECRETS_UNBIND, 'ws-1', 'PAGER_TOKEN');
    expect(bindings.names('ws-1', P)).toEqual([]);
    expect(automations.reload.mock.calls).toEqual([['ws-1'], ['ws-1']]);
  });

  it('lists the view, and a file that did not read with its problem, reloading every workspace once it reads', async () => {
    fs.writeFileSync(file, 'not json');
    const { call, automations } = wire();
    const before = await call(IPC_CHANNELS.SECRETS_LIST, 'ws-1');
    expect(before).toMatchObject({ problem: expect.any(String), secrets: [] });
    expect(automations.reload).not.toHaveBeenCalled();
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces: {} }));
    expect(await call(IPC_CHANNELS.SECRETS_LIST, 'ws-1')).toEqual({ secrets: [] });
    expect(automations.reload.mock.calls).toEqual([['ws-1'], ['ws-2']]);
    expect(automations.secretsView.mock.calls).toEqual([['ws-1'], ['ws-1']]);
  });

  it("lets a deleted workspace's bindings go when the workspace list changes (review M5)", async () => {
    const { held, changes, bindings } = wire();
    bindings.bind('ws-1', P, 'PAGER_TOKEN', ENV_REF);
    bindings.bind('ws-2', P, 'PAGER_TOKEN', ENV_REF);
    expect(changes).toHaveLength(1);
    held.ids = ['ws-1'];
    for (const change of changes) change();
    expect(bindings.names('ws-1', P)).toEqual(['PAGER_TOKEN']);
    expect(bindings.names('ws-2', P)).toEqual([]);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toContain('ws-2');
  });
});
