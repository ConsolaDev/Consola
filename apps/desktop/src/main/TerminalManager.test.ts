import { describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({
  created: [] as Array<{
    options: unknown;
    queued: string[];
    fresh: Array<[string, string | undefined]>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }>,
}));

vi.mock('./TerminalService', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeTerminalService extends EventEmitter {
    public readonly queued: string[] = [];
    public readonly fresh: Array<[string, string | undefined]> = [];
    constructor(public readonly options: { claudeSessionId: string }) {
      super();
      created.push(this);
    }
    start() {}
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
