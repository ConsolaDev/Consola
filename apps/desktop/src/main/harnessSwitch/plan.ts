import type { HarnessSwitchMode } from '../../shared/harnessSwitch';
import type { HarnessDriverId } from '../../shared/types';
import type { HarnessDriver } from '../drivers';

/**
 * What a driver can do with one of its conversations, as far as a harness
 * switch cares — read from which optional methods it implements, so a new
 * driver takes part by implementing them and nothing here changes.
 */
export interface ConversationSupport {
  driverId: HarnessDriverId;
  /** It can make a conversation forkable from another harness of the same driver. */
  transplant: boolean;
  /** It can read a conversation back as a transcript. */
  readable: boolean;
}

export function conversationSupport(driver: HarnessDriver): ConversationSupport {
  return {
    driverId: driver.id,
    transplant: typeof driver.transplantConversation === 'function',
    readable: typeof driver.readConversation === 'function',
  };
}

export type HarnessSwitchPlan =
  | { ok: true; mode: HarnessSwitchMode }
  | { ok: false; reason: string };

/**
 * How a session's conversation would reach another harness: the only place
 * that decides. A native fork is preferred because nothing is lost; a
 * handoff is the way between CLIs, and between harnesses of a CLI that
 * cannot fork; a conversation neither can carry is refused.
 */
export function planHarnessSwitch(input: {
  source: ConversationSupport;
  target: ConversationSupport;
  sourceName: string;
  targetName: string;
  hasStarted: boolean;
}): HarnessSwitchPlan {
  if (!input.hasStarted) return { ok: true, mode: 'unstarted' };
  if (input.source.driverId === input.target.driverId && input.source.transplant) {
    return { ok: true, mode: 'native' };
  }
  if (input.source.readable) return { ok: true, mode: 'handoff' };
  return {
    ok: false,
    reason:
      `${input.sourceName} keeps its conversations where Consola cannot read them, ` +
      `so this one cannot be carried to ${input.targetName}.`,
  };
}

/** What each mode means for the person choosing, in the dialog. */
export function describeSwitch(mode: HarnessSwitchMode, targetName: string): string {
  switch (mode) {
    case 'native':
      return `Continues this conversation on ${targetName} with its full history, tool results included.`;
    case 'handoff':
      return (
        `Starts a new conversation on ${targetName} that first reads a transcript of this one: ` +
        'prompts, replies and the tools used, but not what those tools returned.'
      );
    case 'unstarted':
      return `Nothing has been said yet, so the session simply starts on ${targetName}.`;
  }
}
