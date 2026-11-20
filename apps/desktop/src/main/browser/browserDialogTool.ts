import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { answer, type CallerAccess, plain, tabIdInput } from './browserToolAccess';
import type { BrowserActToolsDeps } from './browserPageSteps';
import type { BrowserToolContent } from './browserToolResults';
import { NO_DIALOG_MESSAGE } from './PageDialogs';

/**
 * `consola_browser_dialog`: answers the alert or confirm held for the agent
 * on a tab (`PageDialogs`), which takes the tab into the agent's hands.
 */
export function addDialogTool(
  server: McpServer,
  deps: BrowserActToolsDeps,
  access: CallerAccess,
): void {
  server.registerTool(
    'consola_browser_dialog',
    {
      description:
        "Answer the alert or confirm a page of your session's browser is waiting on " +
        '(consola_browser_status lists it as pendingDialog): accept or dismiss it, with text ' +
        'for a prompt. The page does nothing else until it is answered; one left unanswered is ' +
        'dismissed after 60 s, and one the person presses in the tab is handed to them.',
      inputSchema: {
        tabId: tabIdInput,
        action: z.enum(['accept', 'dismiss']),
        text: z.string().optional().describe('For a prompt: the text to answer with.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (args) => answer(() => answerDialog(deps, access, args)),
  );
}

async function answerDialog(
  deps: BrowserActToolsDeps,
  access: CallerAccess,
  args: { tabId: string; action: 'accept' | 'dismiss'; text?: string },
): Promise<BrowserToolContent[]> {
  const tab = access.tab(args.tabId);
  const pending = deps.dialogs.pendingFor(tab.id);
  if (!pending) throw new Error(NO_DIALOG_MESSAGE);
  if (args.text !== undefined && pending.type !== 'prompt') {
    throw new Error(`Only a prompt dialog takes text; this one is a ${pending.type}.`);
  }
  // The page goes on from the answer, so the tab is in the agent's hands from here.
  deps.person.noteAgentUse(tab.id);
  const answered = deps.dialogs.answer(tab.id, args.action === 'accept', args.text);
  // Gone between the two: the page navigated, or the wait ran out.
  if (!answered) throw new Error(NO_DIALOG_MESSAGE);
  const verb = args.action === 'accept' ? 'Accepted' : 'Dismissed';
  return plain({
    tabId: tab.id,
    summary: `${verb} the ${answered.type} dialog. Take a snapshot to see what the page did.`,
  });
}
