import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStateFile } from '../state/JsonStateFile';
import { BindingsStore, bindingsFileProblem, type SecretBindingsFile } from './BindingsStore';
import type { BindingRef } from './references';

const PAGER: BindingRef = {
  kind: 'keychain',
  service: 'consola/ws-1/personal',
  account: 'PAGER_TOKEN',
};
const SLACK_ONE: BindingRef = { kind: 'env', name: 'SLACK_BOT_TOKEN' };
const SLACK_TWO: BindingRef = { kind: '1password', reference: 'op://Ops/Slack/bot-token' };

let dir: string;
let clock: Date;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-bindings-'));
  clock = new Date('2026-11-16T08:00:00.000Z');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const filePath = () => path.join(dir, 'secret-bindings.json');
const backupPath = () => `${filePath()}.bak`;
const bytes = () => fs.readFileSync(filePath(), 'utf8');

function open(): { store: BindingsStore; file: JsonStateFile<SecretBindingsFile> } {
  const file = new JsonStateFile<SecretBindingsFile>(filePath());
  return { store: new BindingsStore(file, () => clock), file };
}

function writeRaw(content: string): void {
  fs.writeFileSync(filePath(), content);
}

describe('BindingsStore', () => {
  it('keeps a binding across a restart, references only, in the file’s one shape', () => {
    const { store } = open();
    expect(store.problem).toBeNull();
    expect(store.names('ws-1', 'personal')).toEqual([]);
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);

    const again = open().store;
    expect(again.get('ws-1', 'personal', 'PAGER_TOKEN')).toEqual({
      ref: PAGER,
      boundAt: '2026-11-16T08:00:00.000Z',
    });
    expect(again.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN']);
    expect(JSON.parse(bytes())).toEqual({
      version: 1,
      workspaces: {
        'ws-1': {
          factories: {
            personal: {
              PAGER_TOKEN: {
                ref: 'keychain:consola/ws-1/personal/PAGER_TOKEN',
                boundAt: '2026-11-16T08:00:00.000Z',
              },
            },
          },
        },
      },
    });
  });

  it('keeps `op` only with a 1Password binding', () => {
    const { store } = open();
    store.bind('ws-1', 'personal', 'SLACK_BOT_TOKEN', SLACK_TWO, '/opt/homebrew/bin/op');
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    const file = JSON.parse(bytes()) as SecretBindingsFile;
    expect(file.workspaces['ws-1'].factories.personal.SLACK_BOT_TOKEN).toEqual({
      ref: 'op://Ops/Slack/bot-token',
      op: '/opt/homebrew/bin/op',
      boundAt: '2026-11-16T08:00:00.000Z',
    });
    expect(Object.keys(file.workspaces['ws-1'].factories.personal.PAGER_TOKEN).sort()).toEqual([
      'boundAt',
      'ref',
    ]);
    expect(open().store.get('ws-1', 'personal', 'SLACK_BOT_TOKEN')).toEqual({
      ref: SLACK_TWO,
      op: '/opt/homebrew/bin/op',
      boundAt: '2026-11-16T08:00:00.000Z',
    });
  });

  it('keeps workspaces and factories apart', () => {
    const { store } = open();
    store.bind('ws-1', 'personal', 'SLACK_BOT_TOKEN', SLACK_ONE);
    store.bind('ws-2', 'personal', 'SLACK_BOT_TOKEN', SLACK_TWO, '/opt/homebrew/bin/op');
    store.bind('ws-1', 'team', 'PAGER_TOKEN', PAGER);
    expect(store.get('ws-1', 'personal', 'SLACK_BOT_TOKEN')?.ref).toEqual(SLACK_ONE);
    expect(store.get('ws-2', 'personal', 'SLACK_BOT_TOKEN')?.ref).toEqual(SLACK_TWO);
    expect(store.names('ws-1', 'personal')).toEqual(['SLACK_BOT_TOKEN']);
    expect(store.names('ws-1', 'team')).toEqual(['PAGER_TOKEN']);
    expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')).toBeNull();
    expect(store.names('ws-3', 'personal')).toEqual([]);
  });

  it('moves `boundAt` on a rebind', () => {
    const { store } = open();
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    clock = new Date('2026-11-17T09:30:00.000Z');
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', SLACK_ONE);
    expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')).toEqual({
      ref: SLACK_ONE,
      boundAt: '2026-11-17T09:30:00.000Z',
    });
  });

  it('removes the name on unbind, and the workspace once it holds none', () => {
    const { store } = open();
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    store.bind('ws-1', 'personal', 'SLACK_BOT_TOKEN', SLACK_ONE);
    store.bind('ws-2', 'personal', 'PAGER_TOKEN', PAGER);
    store.unbind('ws-1', 'personal', 'PAGER_TOKEN');
    expect(store.names('ws-1', 'personal')).toEqual(['SLACK_BOT_TOKEN']);
    store.unbind('ws-1', 'personal', 'SLACK_BOT_TOKEN');
    expect(Object.keys((JSON.parse(bytes()) as SecretBindingsFile).workspaces)).toEqual(['ws-2']);
    expect(open().store.names('ws-1', 'personal')).toEqual([]);
  });

  it('refuses a name a secret cannot have', () => {
    const { store } = open();
    expect(() => store.bind('ws-1', 'personal', 'pager', PAGER)).toThrow(
      'Use uppercase letters, digits and underscores, e.g. PAGERDUTY_TOKEN.',
    );
    expect(() => store.bind('ws-1', 'personal', `P${'A'.repeat(64)}`, PAGER)).toThrow(
      "A secret's name is at most 64 characters.",
    );
    expect(fs.existsSync(filePath())).toBe(false);
  });

  it('changes nothing when the file cannot be written', () => {
    const { store, file } = open();
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    const changed = vi.fn();
    store.onChange(changed);
    vi.spyOn(file, 'write').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => store.bind('ws-1', 'personal', 'TRACKER_TOKEN', SLACK_ONE)).toThrow('disk full');
    expect(() => store.unbind('ws-1', 'personal', 'PAGER_TOKEN')).toThrow('disk full');
    expect(store.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('fires onChange once per bind and unbind, and not for a failed one', () => {
    const { store } = open();
    const changed = vi.fn();
    store.onChange(changed);
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(() => store.bind('ws-1', 'personal', 'pager', PAGER)).toThrow();
    expect(changed).toHaveBeenCalledTimes(1);
    store.unbind('ws-1', 'personal', 'PAGER_TOKEN');
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('reads a workspace, factory or name named like a plain object’s own members as nothing', () => {
    writeRaw(
      '{"version":1,"workspaces":{"__proto__":{"factories":{"personal":{"PAGER_TOKEN":{"ref":"env:PAGER_TOKEN","boundAt":"2026-11-15T10:00:00.000Z"}}}}}}',
    );
    const { store, file } = open();
    expect(store.problem).toBeNull();
    expect(store.names('__proto__', 'personal')).toEqual([]);
    expect(store.names('constructor', 'personal')).toEqual([]);
    store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
    expect(Object.keys((JSON.parse(bytes()) as SecretBindingsFile).workspaces)).toEqual(['ws-1']);
    expect(store.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN']);
    expect(store.get('ws-1', 'personal', 'constructor')).toBeNull();
    expect(store.get('ws-1', 'personal', 'toString')).toBeNull();
    const write = vi.spyOn(file, 'write');
    store.unbind('ws-1', 'personal', 'toString');
    store.unbind('ws-1', 'constructor', 'PAGER_TOKEN');
    expect(write).not.toHaveBeenCalled();
  });

  describe('a file someone edited by hand (Review Focus 4)', () => {
    it.each([
      ['not JSON', 'not json', "it isn't readable JSON"],
      [
        'a version 2',
        JSON.stringify({ version: 2, workspaces: {} }),
        "it isn't a version 1 bindings file",
      ],
      ['a list', '[]', "it isn't a version 1 bindings file"],
      ['no workspaces', JSON.stringify({ version: 1 }), "it isn't a version 1 bindings file"],
    ])(
      '%s: binds nothing, unbinds nothing, prunes nothing, and writes nothing',
      (_name, content, reason) => {
        writeRaw(content);
        const { store, file } = open();
        const write = vi.spyOn(file, 'write');
        const changed = vi.fn();
        store.onChange(changed);
        expect(store.problem).toBe(bindingsFileProblem(reason));
        expect(store.problem).toBe(
          `Consola couldn't read secret-bindings.json (${reason}), so no secret reads as bound; fix or remove the file, then reopen this tab.`,
        );
        expect(store.names('ws-1', 'personal')).toEqual([]);
        expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')).toBeNull();
        expect(() => store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER)).toThrow(
          bindingsFileProblem(reason),
        );
        expect(bytes()).toBe(content);
        expect(() => store.unbind('ws-1', 'personal', 'PAGER_TOKEN')).toThrow(
          bindingsFileProblem(reason),
        );
        expect(bytes()).toBe(content);
        expect(() => store.keepWorkspaces(new Set())).not.toThrow();
        expect(bytes()).toBe(content);
        expect(write).not.toHaveBeenCalled();
        expect(changed).not.toHaveBeenCalled();
        expect(fs.existsSync(backupPath())).toBe(false);
      },
    );

    it('reads a fixed file at the next look (review S4)', () => {
      writeRaw('not json');
      const { store } = open();
      const changed = vi.fn();
      store.onChange(changed);
      expect(store.retry()).toBe(false);
      expect(bytes()).toBe('not json');
      expect(store.problem).not.toBeNull();

      writeRaw(
        JSON.stringify({
          version: 1,
          workspaces: {
            'ws-1': {
              factories: {
                personal: {
                  PAGER_TOKEN: { ref: 'env:PAGER_TOKEN', boundAt: '2026-11-15T10:00:00Z' },
                },
              },
            },
          },
        }),
      );
      expect(store.retry()).toBe(true);
      expect(store.problem).toBeNull();
      expect(store.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN']);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(store.retry()).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('never reads a `value` someone wrote, and drops it from the file at the next write (review M12)', () => {
      writeRaw(
        JSON.stringify({
          version: 1,
          workspaces: {
            'ws-1': {
              factories: {
                personal: {
                  PAGER_TOKEN: {
                    ref: 'env:PAGER_TOKEN',
                    boundAt: '2026-11-15T10:00:00.000Z',
                    value: 'stub-hand-value-1',
                  },
                },
              },
            },
          },
        }),
      );
      const { store } = open();
      expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')).toEqual({
        ref: { kind: 'env', name: 'PAGER_TOKEN' },
        boundAt: '2026-11-15T10:00:00.000Z',
      });
      store.bind('ws-1', 'personal', 'TRACKER_TOKEN', SLACK_ONE);
      expect(bytes()).not.toContain('stub-hand-value-1');
      expect(fs.readFileSync(backupPath(), 'utf8')).toContain('stub-hand-value-1');
      store.bind('ws-1', 'personal', 'SLACK_BOT_TOKEN', SLACK_ONE);
      expect(bytes()).not.toContain('stub-hand-value-1');
      expect(fs.readFileSync(backupPath(), 'utf8')).not.toContain('stub-hand-value-1');
      expect(open().store.get('ws-1', 'personal', 'PAGER_TOKEN')?.ref).toEqual({
        kind: 'env',
        name: 'PAGER_TOKEN',
      });
    });

    it('reads a binding whose reference does not parse as unbound, and a bind replaces it', () => {
      writeRaw(
        JSON.stringify({
          version: 1,
          workspaces: {
            'ws-1': {
              factories: {
                personal: {
                  PAGER_TOKEN: { ref: 'nonsense', boundAt: '2026-11-15T10:00:00.000Z' },
                  TRACKER_TOKEN: { ref: 'env:TRACKER_TOKEN', boundAt: '2026-11-15T10:00:00.000Z' },
                  SLACK_BOT_TOKEN: { ref: 42, boundAt: '2026-11-15T10:00:00.000Z' },
                },
              },
            },
          },
        }),
      );
      const { store } = open();
      expect(store.problem).toBeNull();
      expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')).toBeNull();
      expect(store.get('ws-1', 'personal', 'SLACK_BOT_TOKEN')).toBeNull();
      expect(store.names('ws-1', 'personal')).toEqual(['TRACKER_TOKEN']);
      store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
      expect(store.get('ws-1', 'personal', 'PAGER_TOKEN')?.ref).toEqual(PAGER);
      expect(store.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN', 'TRACKER_TOKEN']);
    });
  });

  describe('keepWorkspaces (Call 14)', () => {
    it('drops the bindings of every workspace it is not given', () => {
      const { store } = open();
      store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
      store.bind('ws-2', 'personal', 'PAGER_TOKEN', PAGER);
      const changed = vi.fn();
      store.onChange(changed);
      store.keepWorkspaces(new Set(['ws-1']));
      expect(store.names('ws-2', 'personal')).toEqual([]);
      expect(store.names('ws-1', 'personal')).toEqual(['PAGER_TOKEN']);
      expect(Object.keys((JSON.parse(bytes()) as SecretBindingsFile).workspaces)).toEqual(['ws-1']);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when it removes nothing (review S5)', () => {
      const first = open();
      first.store.bind('ws-1', 'personal', 'PAGER_TOKEN', PAGER);
      first.store.bind('ws-2', 'personal', 'PAGER_TOKEN', PAGER);
      const before = bytes();
      const { store, file } = open();
      const write = vi.spyOn(file, 'write');
      const changed = vi.fn();
      store.onChange(changed);
      store.keepWorkspaces(new Set(['ws-1', 'ws-2', 'ws-3']));
      expect(write).not.toHaveBeenCalled();
      expect(bytes()).toBe(before);
      expect(changed).not.toHaveBeenCalled();
    });
  });
});
