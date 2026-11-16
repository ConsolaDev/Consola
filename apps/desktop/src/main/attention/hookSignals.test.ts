import { describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import { HookSignals, type AttentionSignal } from './hookSignals';

const menu: AttentionSignal = { kind: 'needs-input', origin: 'menu' };
const subagent: AttentionSignal = { kind: 'needs-input', origin: 'subagent' };

function signals(...status: TerminalStatus[]) {
  const hooks = new HookSignals();
  for (const s of status) hooks.statusChanged('i', s);
  return hooks;
}

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

  it.each([
    ['idle', { kind: 'idle' } as AttentionSignal],
    ['a turn ending', { kind: 'turn-ended', backgroundWork: 0 } as AttentionSignal],
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

  it('holds a turn that ended with background work, until the next turn or a clean stop', () => {
    const hooks = signals('working');
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 1 });
    expect(hooks.get('i')?.holdingBackgroundWork).toBe(true);
    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 0 });
    expect(hooks.get('i')?.holdingBackgroundWork).toBe(false);

    hooks.apply('i', { kind: 'turn-ended', backgroundWork: 2 });
    hooks.statusChanged('i', 'ready');
    hooks.statusChanged('i', 'working'); // a stop never fires for an interrupted turn
    expect(hooks.get('i')?.holdingBackgroundWork).toBe(false);
  });

  it('forgets everything when the process exits or the terminal is destroyed', () => {
    const hooks = signals('ready');
    hooks.apply('i', menu);
    hooks.statusChanged('i', 'exited');
    expect(hooks.get('i')).toEqual({ needsInput: false, holdingBackgroundWork: false });
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
});
