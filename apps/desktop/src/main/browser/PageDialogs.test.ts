import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIALOG_HOLD_MS, MAX_DIALOG_MESSAGE_CHARS, PageDialogs } from './PageDialogs';

/** Electron's own `-run-dialog` listener, which would show a message box. */
type Callback = (success: boolean, input: string) => void;

class FakeGuest extends EventEmitter {
  readonly electronShown: Array<{ details: unknown; callback: Callback }> = [];
  constructor(public readonly id: number) {
    super();
    // What Electron installs on every web contents as it is created.
    this.on('-run-dialog', (details: unknown, callback: Callback) =>
      this.electronShown.push({ details, callback }),
    );
  }
  /** The page calls alert, confirm or prompt. */
  raise(dialogType: string, messageText: string) {
    const answers: Array<[boolean, string]> = [];
    this.emit(
      '-run-dialog',
      { dialogType, messageText, defaultPromptText: '' },
      (ok: boolean, text: string) => answers.push([ok, text]),
    );
    return answers;
  }
  asWebContents() {
    return this as unknown as WebContents;
  }
}

class FakeTimers {
  readonly pending: Array<{ ms: number; fire: () => void }> = [];
  readonly start = (ms: number, fire: () => void) => {
    const timer = { ms, fire };
    this.pending.push(timer);
    return () => {
      const at = this.pending.indexOf(timer);
      if (at >= 0) this.pending.splice(at, 1);
    };
  };
}

let guest: FakeGuest;
let connected: boolean;
let personUsing: boolean;
let tabOf: Record<number, string | null>;
let timers: FakeTimers;
let dialogs: PageDialogs;

beforeEach(() => {
  guest = new FakeGuest(7);
  connected = true;
  personUsing = false;
  tabOf = { 7: 'tab1' };
  timers = new FakeTimers();
  dialogs = new PageDialogs({
    tabIdFor: (guestId) => tabOf[guestId] ?? null,
    isAgentConnected: () => connected,
    personIsUsing: () => personUsing,
    startTimer: timers.start,
  });
  dialogs.takeOver(guest.asWebContents(), guest.id);
});

describe('a page’s dialog', () => {
  it('is held for the agent while an agent is connected: no box, and the page waits', () => {
    const answers = guest.raise('confirm', 'Delete it?');
    expect(guest.electronShown).toEqual([]);
    expect(answers).toEqual([]);
    expect(dialogs.pendingFor('tab1')).toEqual({ type: 'confirm', message: 'Delete it?' });
  });

  it('is answered with the agent’s accept or dismiss, through Electron’s own callback', () => {
    const confirmAnswers = guest.raise('confirm', 'Delete it?');
    expect(dialogs.answer('tab1', true)).toEqual({ type: 'confirm', message: 'Delete it?' });
    expect(confirmAnswers).toEqual([[true, '']]);
    expect(dialogs.pendingFor('tab1')).toBeUndefined();

    const alertAnswers = guest.raise('alert', 'Saved');
    dialogs.answer('tab1', false);
    expect(alertAnswers).toEqual([[false, '']]);

    const promptAnswers = guest.raise('prompt', 'Name?');
    dialogs.answer('tab1', true, 'Ada');
    expect(promptAnswers).toEqual([[true, 'Ada']]);
    expect(timers.pending).toEqual([]);
  });

  it('answering with nothing held does nothing', () => {
    expect(dialogs.answer('tab1', true)).toBeUndefined();
  });

  it('goes to Electron as before when no agent is connected to the page', () => {
    connected = false;
    guest.raise('alert', 'Hello');
    expect(guest.electronShown).toHaveLength(1);
    expect(guest.electronShown[0].details).toMatchObject({
      dialogType: 'alert',
      messageText: 'Hello',
    });
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
  });

  it('is the person’s when they are using the tab', () => {
    personUsing = true;
    guest.raise('confirm', 'Leave?');
    expect(guest.electronShown).toHaveLength(1);
  });

  it('is Electron’s on a page not bound to a tab', () => {
    tabOf[7] = null;
    guest.raise('alert', 'Hello');
    expect(guest.electronShown).toHaveLength(1);
  });

  it('is dismissed on its own after 60 s, so the page is never frozen for good', () => {
    const answers = guest.raise('confirm', 'Delete it?');
    expect(timers.pending.map((timer) => timer.ms)).toEqual([DIALOG_HOLD_MS]);
    expect(DIALOG_HOLD_MS).toBe(60_000);
    timers.pending[0].fire();
    expect(answers).toEqual([[false, '']]);
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
  });

  it('is forgotten when Chromium cancels it (the page navigated or closed)', () => {
    const answers = guest.raise('alert', 'Hello');
    guest.emit('-cancel-dialogs', { resetState: false });
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
    expect(answers).toEqual([]);
    expect(timers.pending).toEqual([]);
  });

  it('is forgotten with its page', () => {
    guest.raise('alert', 'Hello');
    guest.emit('destroyed');
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
  });

  it('is dismissed when the agent’s connection to the page ends', () => {
    const answers = guest.raise('confirm', 'Delete it?');
    dialogs.letGo(guest.asWebContents());
    expect(answers).toEqual([[false, '']]);
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
    // Another page's ending touches nothing.
    guest.raise('alert', 'Again');
    dialogs.letGo(new FakeGuest(8).asWebContents());
    expect(dialogs.pendingFor('tab1')).toBeDefined();
  });

  it('is handed to the person, as Electron shows it, once they press in the tab', () => {
    const answers = guest.raise('confirm', 'Delete it?');
    dialogs.handToPerson('tab1');
    expect(dialogs.pendingFor('tab1')).toBeUndefined();
    expect(timers.pending).toEqual([]);
    expect(guest.electronShown).toHaveLength(1);
    expect(guest.electronShown[0].details).toMatchObject({ messageText: 'Delete it?' });
    // The person's answer reaches the page.
    guest.electronShown[0].callback(true, '');
    expect(answers).toEqual([[true, '']]);
    dialogs.handToPerson('tab1');
    expect(guest.electronShown).toHaveLength(1);
  });

  it('keeps only so much of what a page writes in it', () => {
    guest.raise('alert', 'x'.repeat(MAX_DIALOG_MESSAGE_CHARS + 500));
    const message = dialogs.pendingFor('tab1')?.message ?? '';
    expect(message.length).toBeLessThan(MAX_DIALOG_MESSAGE_CHARS + 100);
    expect(message).toMatch(/\(500 more characters\)$/);
  });
});

describe('waiting for a dialog', () => {
  it('hears one opened during a call, at once if one is already held', async () => {
    const controller = new AbortController();
    const opened = dialogs.opened('tab1', controller.signal);
    guest.raise('alert', 'Saved');
    await expect(opened).resolves.toEqual({ type: 'alert', message: 'Saved' });
    await expect(dialogs.opened('tab1', controller.signal)).resolves.toEqual({
      type: 'alert',
      message: 'Saved',
    });
  });

  it('stops listening once the call is over', async () => {
    const controller = new AbortController();
    const heard = vi.fn();
    void dialogs.opened('tab1', controller.signal).then(heard);
    controller.abort();
    guest.raise('alert', 'Late');
    await new Promise((resolve) => setImmediate(resolve));
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('taking over', () => {
  it('leaves a page alone, and says so, when Electron’s dialogs are not as expected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const odd = new FakeGuest(9);
    odd.removeAllListeners('-run-dialog');
    dialogs.takeOver(odd.asWebContents(), odd.id);
    expect(odd.listenerCount('-run-dialog')).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dialog'));
    warn.mockRestore();
  });
});
