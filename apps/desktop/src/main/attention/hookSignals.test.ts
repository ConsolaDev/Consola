import { describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { HookSignals } from './hookSignals';
import type { AttentionSignal } from './hookSignals';

const menu: AttentionSignal = { kind: 'needs-input', origin: 'menu' };
const subagent: AttentionSignal = { kind: 'needs-input', origin: 'subagent' };

function signals(...status: TerminalStatus[]) {
  const hooks = new HookSignals();
  for (const s of status) hooks.statusChanged('i', s);
  return hooks;
}

describe('a failed turn', () => {
  it('ends what a turn latched, as a normal stop would', () => {
    const signals = new HookSignals();
    signals.apply('t', { kind: 'needs-input', origin: 'question' });
    signals.apply('t', { kind: 'turn-ended', backgroundWork: 2, backgroundAgents: 1 });
    signals.apply('t', { kind: 'needs-input', origin: 'menu' });
    signals.apply('t', { kind: 'needs-input', origin: 'question' });
    signals.apply('t', { kind: 'resumed' });
    signals.apply('t', { kind: 'turn-failed', limit: true });
    expect(signals.get('t')).toEqual({
      needsInput: false,
      holdingBackgroundWork: false,
      awaitingAgents: false,
      turn: 'over',
    });
  });
});

describe('HookSignals', () => {
  it('knows nothing of a terminal no hook has spoken for', () => {
    expect(new HookSignals().get('i')).toBeUndefined();
  });

  it('holds a needs-input until something ends it', () => {
    const hooks = signals('ready');
    hooks.apply('i', menu);
    expect(hooks.get('i')?.needsInput).toBe(true);
    hooks.statusChanged('i', 'needs-attention');
    expect(hooks.get('i')?.needsInput).toBe(true);
  });

  it('lapses when output starts again after quiet: the person answered', () => {
    const hooks = signals('needs-attention');
    hooks.apply('i', menu);
    hooks.statusChanged('i', 'working');
    expect(hooks.get('i')?.needsInput).toBe(false);
  });

  it('does not lapse on output that was already flowing when the hook arrived', () => {
    const hooks = signals('working');
    hooks.apply('i', menu);
    hooks.statusChanged('i', 'working');
    expect(hooks.get('i')?.needsInput).toBe(true);
  });

  it.each<[string, AttentionSignal]>([
    ['idle', { kind: 'idle' }],
    ['a turn ending', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 }],
  ])('ends on %s', (_name, signal) => {
    const hooks = signals('ready');
    hooks.apply('i', menu);
    hooks.apply('i', signal);
    expect(hooks.get('i')?.needsInput).toBe(false);
  });

  it('ends a subagent’s question when the subagent finishes, but not a menu', () => {
    const hooks = signals('working');
    hooks.apply('i', subagent);
    hooks.apply('i', { kind: 'subagent-finished' });
    expect(hooks.get('i')?.needsInput).toBe(false);
    hooks.apply('i', menu);
    hooks.apply('i', { kind: 'subagent-finished' });
    expect(hooks.get('i')?.needsInput).toBe(true);
  });

  it('holds a turn that ended with background work until a stop reports none left', () => {
    const hooks = signals('working');
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 });
    expect(hooks.get('i')).toMatchObject({ holdingBackgroundWork: true, awaitingAgents: false });
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
    expect(hooks.get('i')).toMatchObject({ holdingBackgroundWork: false, awaitingAgents: false });
  });

  it('says the agent awaits its own subagents while a stop reports any still running', () => {
    const hooks = signals('working');
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 3, backgroundAgents: 2 });
    expect(hooks.get('i')).toMatchObject({ holdingBackgroundWork: true, awaitingAgents: true });
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 0 }); // only a dev server left
    expect(hooks.get('i')).toMatchObject({ holdingBackgroundWork: true, awaitingAgents: false });
  });

  it('keeps the hold through output after the turn: a waiting agent repaints its panel of subagents', () => {
    // Observed live (2.1.326): while Claude waits on background agents its
    // spinner stops, but the panel beneath the composer repaints elapsed time
    // and token counts about once a second. That reads as `working` and quiet
    // again, over and over, and is no new turn: the next one reports at its stop.
    const hooks = signals('working');
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 2, backgroundAgents: 2 });
    for (const status of ['ready', 'working', 'ready', 'working', 'ready'] as const) {
      hooks.statusChanged('i', status);
    }
    expect(hooks.get('i')).toMatchObject({ holdingBackgroundWork: true, awaitingAgents: true });
  });

  it('forgets everything when the process exits or the terminal is destroyed', () => {
    const hooks = signals('ready');
    hooks.apply('i', menu);
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 2, backgroundAgents: 2 });
    hooks.apply('i', menu);
    hooks.statusChanged('i', 'exited');
    expect(hooks.get('i')).toEqual({
      needsInput: false,
      holdingBackgroundWork: false,
      awaitingAgents: false,
      turn: undefined,
    });
    hooks.forget('i');
    expect(hooks.get('i')).toBeUndefined();
  });

  it('tells subscribers only about changes', () => {
    const hooks = signals('ready');
    const cb = vi.fn();
    hooks.subscribe(cb);
    hooks.apply('i', menu);
    hooks.apply('i', menu);
    expect(cb).toHaveBeenCalledTimes(1);
    hooks.apply('i', { kind: 'idle' });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  describe('a prompt that was already answered', () => {
    const lagging: AttentionSignal = { kind: 'needs-input', origin: 'menu', lagging: true };

    it('ignores a lagging notification that lands while output is flowing', () => {
      const hooks = signals('needs-attention', 'working'); // the person answered
      hooks.apply('i', lagging);
      expect(hooks.get('i')?.needsInput).toBe(false);
    });

    it('still takes a lagging notification when the screen is quiet: the only word on an unrecognised menu', () => {
      const hooks = signals('working', 'ready');
      hooks.apply('i', lagging);
      expect(hooks.get('i')?.needsInput).toBe(true);
    });

    it('ends a menu on a tool having run or a prompt submitted, with no status edge to do it', () => {
      const hooks = signals('working'); // a menu that never let the spinner stop
      hooks.apply('i', menu);
      expect(hooks.get('i')?.needsInput).toBe(true);
      hooks.apply('i', { kind: 'resumed' });
      expect(hooks.get('i')?.needsInput).toBe(false);
    });

    it('keeps a pending menu when a different tool call completes: a parallel call or a subagent', () => {
      const hooks = signals('working');
      hooks.apply('i', { kind: 'needs-input', origin: 'menu', tool: 'Bash:{"command":"curl x"}' });
      hooks.apply('i', { kind: 'resumed', tool: 'Read:{"file_path":"/etc/hosts"}' });
      expect(hooks.get('i')?.needsInput).toBe(true);
      hooks.apply('i', { kind: 'resumed', tool: 'Bash:{"command":"curl x"}' }); // its own call ran: answered
      expect(hooks.get('i')?.needsInput).toBe(false);
    });

    it('keeps a prompt that names no call (an unrecognised question) through any tool completing', () => {
      const hooks = signals('working');
      hooks.apply('i', { kind: 'needs-input', origin: 'question' });
      hooks.apply('i', { kind: 'resumed', tool: 'Read:{}' });
      expect(hooks.get('i')?.needsInput).toBe(true);
      hooks.apply('i', { kind: 'resumed' }); // the person submitted a prompt
      expect(hooks.get('i')?.needsInput).toBe(false);
    });

    it('lets a subagent’s own call completing end its prompt', () => {
      const hooks = signals('working');
      hooks.apply('i', { kind: 'needs-input', origin: 'subagent', tool: 'Read:{}' });
      hooks.apply('i', { kind: 'resumed', tool: 'Read:{}' });
      expect(hooks.get('i')?.needsInput).toBe(false);
    });

    it('leaves a subagent’s question to the subagent', () => {
      const hooks = signals('working');
      hooks.apply('i', subagent);
      hooks.apply('i', { kind: 'resumed' });
      expect(hooks.get('i')?.needsInput).toBe(true);
    });
  });

  describe('where the turn stands', () => {
    it('says nothing until a hook speaks', () => {
      const hooks = signals('working');
      expect(hooks.get('i')?.turn).toBeUndefined();
    });

    it('opens on a submitted prompt and is over at the stop', () => {
      const hooks = signals('ready');
      hooks.apply('i', { kind: 'resumed' });
      expect(hooks.get('i')?.turn).toBe('open');
      hooks.apply('i', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
      expect(hooks.get('i')?.turn).toBe('over');
    });

    it('opens on a call of the session’s own completing: not every turn starts with a prompt', () => {
      const hooks = signals('ready');
      hooks.apply('i', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
      hooks.apply('i', { kind: 'resumed', tool: 'Bash:{}' });
      expect(hooks.get('i')?.turn).toBe('open');
    });

    // Recorded live (2.1.327): a background agent's calls complete for as
    // long as it runs, after the session's own turn has stopped.
    it('stays over while only a subagent’s calls complete', () => {
      const hooks = signals('ready');
      hooks.apply('i', { kind: 'turn-ended', backgroundWork: 1, backgroundAgents: 1 });
      hooks.apply('i', { kind: 'resumed', tool: 'Bash:{}', agent: true });
      expect(hooks.get('i')?.turn).toBe('over');
    });

    it('tells subscribers when it moves, and is forgotten at exit', () => {
      const hooks = signals('ready');
      const heard = vi.fn();
      hooks.subscribe(heard);
      hooks.apply('i', { kind: 'resumed' });
      hooks.apply('i', { kind: 'resumed' });
      expect(heard).toHaveBeenCalledTimes(1);
      hooks.apply('i', { kind: 'turn-ended', backgroundWork: 0, backgroundAgents: 0 });
      expect(heard).toHaveBeenCalledTimes(2);
      hooks.statusChanged('i', 'exited');
      expect(hooks.get('i')?.turn).toBeUndefined();
    });
  });
});
