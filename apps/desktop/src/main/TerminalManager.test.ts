import { describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({
  created: [] as Array<{
    options: unknown;
    queued: string[];
    relaunched: unknown[];
    fresh: Array<[string, string | undefined]>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
}));

vi.mock('./TerminalService', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeTerminalService extends EventEmitter {
    public readonly queued: string[] = [];
    public readonly relaunched: unknown[] = [];
    public readonly fresh: Array<[string, string | undefined]> = [];
    constructor(public readonly options: { claudeSessionId: string }) {
      super();
      created.push(this);
    }
    start() {}
    relaunch(launch: unknown) {
      this.relaunched.push(launch);
    }
    queuePrompt(prompt: string) {
      this.queued.push(prompt);
    }
    conversationId() {
      return this.options.claudeSessionId;
    }
    startFreshConversation(claudeSessionId: string, prompt?: string) {
      this.fresh.push([claudeSessionId, prompt]);
    }
    getReplay() {
      return { replay: '', cols: 80, rows: 24 };
    }
    hasClaudeExited() {
      return false;
    }
    public recorded = 0;
    async recordStepProcesses() {
      this.recorded += 1;
    }
    destroy() {}
  }
  return { TerminalService: FakeTerminalService };
});

import { OUTPUT_BATCH_MS, TerminalManager } from './TerminalManager';
import { IPC_CHANNELS } from '../shared/constants';

const options = { cwd: '/tmp', claudeSessionId: 'abc', resume: true };
const owner = { send: () => {}, isDestroyed: () => false } as never;

describe('TerminalManager.startHeadless', () => {
  it('never hands an unattended turn to a terminal that already exists', () => {
    const manager = new TerminalManager(() => []);
    // The person opened the session first: its pane started an interactive terminal.
    manager.ensure('instance-1', options, owner);
    expect(() =>
      manager.startHeadless('instance-1', {
        ...options,
        unattended: true,
        initialPrompt: 'Go on.',
      }),
    ).toThrow('This session already has a terminal, so its turn cannot run unattended.');
    // Nothing was typed into the person's composer.
    expect(created).toHaveLength(1);
    expect(created[0].queued).toEqual([]);
  });

  it('still queues an ordinary prompt for a terminal that already exists', () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    manager.ensure('instance-1', options, owner);
    manager.startHeadless('instance-1', { ...options, initialPrompt: 'Review it.' });
    expect(created[0].queued).toEqual(['Review it.']);
  });

  it('moves a terminal running another conversation onto the one a fresh start asks for', () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    // A pane mounted while the fresh start was being prepared, and
    // resumed the conversation the record named a moment earlier.
    manager.ensure('instance-1', options, owner);
    manager.startHeadless('instance-1', {
      ...options,
      claudeSessionId: 'new',
      resume: false,
      initialPrompt: 'Review again.',
    });
    expect(created).toHaveLength(1);
    expect(created[0].fresh).toEqual([['new', 'Review again.']]);
    // Never typed into the old conversation.
    expect(created[0].queued).toEqual([]);
  });
});

describe('TerminalManager listeners', () => {
  it('tells every status and exit listener, and one that throws does not silence the rest', () => {
    created.length = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const seen: string[] = [];
    manager.addStatusListener(() => {
      throw new Error('boom');
    });
    manager.addStatusListener((id, status) => seen.push(`${id}:${status}`));
    manager.addExitListener(() => {
      throw new Error('boom');
    });
    manager.addExitListener((id, info) => seen.push(`${id}:exit:${info.exitCode}`));
    created[0].emit('status', 'working');
    created[0].emit('exit', { exitCode: 2 });
    expect(seen).toEqual(['inst-1:working', 'inst-1:exit:2']);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it('stops calling a listener once it unsubscribes', () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const status = vi.fn();
    const exit = vi.fn();
    const offStatus = manager.addStatusListener(status);
    const offExit = manager.addExitListener(exit);
    offStatus();
    offExit();
    created[0].emit('status', 'working');
    created[0].emit('exit', { exitCode: 0 });
    expect(status).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('TerminalManager turn reports', () => {
  const report = {
    init: { model: 'claude-stub-1', servers: [], raw: { type: 'system' } },
    result: { subtype: 'success', isError: false, deniedTools: [], raw: { type: 'result' } },
    otherLines: ['Warning: x'],
    limitNotice: false,
    maxTurns: 6,
  };

  it("forwards a terminal's turn-init to its listeners", () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const heard: unknown[] = [];
    manager.addTurnInitListener((id, init) => heard.push([id, init]));
    created[0].emit('turn-init', report.init);
    expect(heard).toEqual([['inst-1', report.init]]);
  });

  it('a turn-init listener that throws does not silence the others', () => {
    created.length = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const heard: string[] = [];
    manager.addTurnInitListener(() => {
      throw new Error('boom');
    });
    manager.addTurnInitListener((id) => heard.push(id));
    expect(() => created[0].emit('turn-init', report.init)).not.toThrow();
    expect(heard).toEqual(['inst-1']);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('an unsubscribed turn-init listener hears nothing', () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const listener = vi.fn();
    const off = manager.addTurnInitListener(listener);
    off();
    created[0].emit('turn-init', report.init);
    expect(listener).not.toHaveBeenCalled();
  });

  it("an exit's report reaches main's listeners, not the windows", () => {
    created.length = 0;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const contents = {
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      isDestroyed: () => false,
    } as never;
    const manager = new TerminalManager(() => [
      { isDestroyed: () => false, webContents: contents } as never,
    ]);
    manager.ensure('inst-1', options, contents);
    const exits: unknown[] = [];
    manager.addExitListener((_id, info) => exits.push(info));
    created[0].emit('exit', { exitCode: 0, unattended: true, report });
    expect(exits).toEqual([{ exitCode: 0, unattended: true, report }]);
    const broadcast = sent.filter((m) => m.channel === IPC_CHANNELS.TERMINAL_EXIT);
    expect(broadcast).toEqual([
      {
        channel: IPC_CHANNELS.TERMINAL_EXIT,
        payload: { instanceId: 'inst-1', exitCode: 0, unattended: true },
      },
    ]);
    expect(Object.prototype.hasOwnProperty.call(broadcast[0].payload, 'report')).toBe(false);
  });
});

describe('TerminalManager output', () => {
  /** A window that records what crosses to it. */
  function window() {
    const sent: Array<{ channel: string; payload: { instanceId: string; data?: string } }> = [];
    return {
      sent,
      contents: {
        send: (channel: string, payload: { instanceId: string; data?: string }) =>
          sent.push({ channel, payload }),
        isDestroyed: () => false,
      } as never,
    };
  }
  const data = (w: ReturnType<typeof window>) =>
    w.sent.filter((m) => m.channel === IPC_CHANNELS.TERMINAL_DATA).map((m) => m.payload.data);

  it('sends one repaint’s many reads as one message', () => {
    vi.useFakeTimers();
    created.length = 0;
    const manager = new TerminalManager(() => []);
    const view = window();
    manager.ensure('inst-1', options, view.contents);
    for (let i = 0; i < 12; i++) created[0].emit('data', `read ${i};`);
    expect(data(view)).toEqual([]);
    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(data(view)).toEqual([Array.from({ length: 12 }, (_, i) => `read ${i};`).join('')]);
    vi.useRealTimers();
  });

  it('sends nothing for a terminal whose view unmounted, and resumes on the next mount', () => {
    vi.useFakeTimers();
    created.length = 0;
    const manager = new TerminalManager(() => []);
    const view = window();
    manager.ensure('inst-1', options, view.contents);
    created[0].emit('data', 'gathered, then unmounted');
    manager.release('inst-1', view.contents);
    created[0].emit('data', 'while nobody looks');
    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(data(view)).toEqual([]);

    manager.ensure('inst-1', options, view.contents);
    created[0].emit('data', 'after the snapshot');
    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(data(view)).toEqual(['after the snapshot']);
    vi.useRealTimers();
  });

  it('drops what was gathered when a view attaches: its snapshot holds it', () => {
    vi.useFakeTimers();
    created.length = 0;
    const manager = new TerminalManager(() => []);
    const view = window();
    manager.ensure('inst-1', options, view.contents);
    created[0].emit('data', 'already in the screen');
    manager.ensure('inst-1', options, view.contents);
    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(data(view)).toEqual([]);
    vi.useRealTimers();
  });

  it('lets only the window that owns a terminal release it', () => {
    vi.useFakeTimers();
    created.length = 0;
    const manager = new TerminalManager(() => []);
    const first = window();
    const second = window();
    manager.ensure('inst-1', options, first.contents);
    // The session moved to another window before the first one's view unmounted.
    manager.ensure('inst-1', options, second.contents);
    manager.release('inst-1', first.contents);
    created[0].emit('data', 'for the second window');
    vi.advanceTimersByTime(OUTPUT_BATCH_MS);
    expect(data(second)).toEqual(['for the second window']);
    expect(data(first)).toEqual([]);
    vi.useRealTimers();
  });

  it('sends the last output before saying the CLI exited', () => {
    vi.useFakeTimers();
    created.length = 0;
    const view = window();
    const manager = new TerminalManager(() => [
      { isDestroyed: () => false, webContents: view.contents } as never,
    ]);
    manager.ensure('inst-1', options, view.contents);
    created[0].emit('data', 'goodbye');
    created[0].emit('exit', { exitCode: 0 });
    expect(view.sent.map((m) => m.channel)).toEqual([
      IPC_CHANNELS.TERMINAL_DATA,
      IPC_CHANNELS.TERMINAL_EXIT,
    ]);
    vi.useRealTimers();
  });
});

describe('TerminalManager.relaunch', () => {
  it('relaunches the terminal it already has, and refuses an unknown one', () => {
    created.length = 0;
    const manager = new TerminalManager(() => []);
    manager.ensure('inst-1', options, owner);
    const launch = { cwd: '/tmp', prompt: 'go', unattended: false };
    manager.relaunch('inst-1', launch);
    expect(created).toHaveLength(1);
    expect(created[0].relaunched).toEqual([launch]);
    expect(() => manager.relaunch('nope', launch)).toThrow('No terminal for nope.');
  });
});

describe("TerminalManager, a write step's Stop (slice 3-B Task 18, Call 8)", () => {
  /** An endpoint that keeps what each terminal's hooks were registered with. */
  const endpoint = () => {
    const registered = new Map<string, ((body: unknown) => Promise<void>) | undefined>();
    return {
      registered,
      urlFor: async (
        instanceId: string,
        _parse: unknown,
        beforeAnswer?: (body: unknown) => Promise<void>,
      ) => {
        registered.set(instanceId, beforeAnswer);
        return 'http://127.0.0.1:1/attention/x';
      },
      unregister: () => {},
    };
  };

  it("waits for a write step's Stop to be recorded, and for nothing else; no other session waits at all", async () => {
    const manager = new TerminalManager(() => []);
    const hooks = endpoint();
    manager.attentionEndpoint = hooks as never;
    for (const [id, toolPolicy] of [
      ['w-1', 'write'],
      ['e-1', 'edit'],
      ['r-1', 'read-only'],
      ['n-1', undefined],
    ] as const) {
      manager.startHeadless(id, { ...options, ...(toolPolicy ? { toolPolicy } : {}) });
      const terminal = created.at(-1)! as unknown as {
        options: { attentionUrl?: () => Promise<string> };
      };
      await terminal.options.attentionUrl?.();
    }
    expect(hooks.registered.get('r-1')).toBeUndefined();
    expect(hooks.registered.get('n-1')).toBeUndefined();
    const write = hooks.registered.get('w-1')!;
    const terminal = manager.get('w-1') as unknown as { recorded: number };
    await write({ hook_event_name: 'Notification' });
    expect(terminal.recorded).toBe(0);
    await write({ hook_event_name: 'Stop' });
    expect(terminal.recorded).toBe(1);
    expect(hooks.registered.get('e-1')).toBeTypeOf('function');
  });
});
