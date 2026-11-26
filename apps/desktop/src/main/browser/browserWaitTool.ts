import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { answer, PageTextError, plain, refuseWhileDialog, tabIdInput } from './browserToolAccess';
import type { CallerAccess } from './browserToolAccess';
import {
  countOf,
  openedDialogContent,
  pageStepFailure,
  refInput,
  staleRefMessage,
  unlessDialog,
} from './browserPageSteps';
import type { BrowserActToolsDeps } from './browserPageSteps';
import { quoted } from './browserToolResults';
import type { BrowserToolContent } from './browserToolResults';
import { PAGE_CALL_TIMEOUT_MS } from './PageDriver';

/** How long `wait_for` waits unless told, and the longest it may. */
export const DEFAULT_WAIT_MS = 10_000;
export const MAX_WAIT_MS = 60_000;

export interface WaitArgs {
  text?: string;
  ref?: string;
  selector?: string;
  url?: string;
  networkIdle?: boolean;
  timeoutMs?: number;
}

/** One wait, checked: what for, and for how long. */
export type WaitPlan = { timeoutMs: number } & (
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'url'; url: string; glob: boolean }
  | { kind: 'network-idle' }
);

/** Checks a wait before anything reaches the page: exactly one thing, for at most a minute. */
export function planWait(args: WaitArgs): WaitPlan {
  const given = [
    args.text,
    args.ref,
    args.selector,
    args.url,
    args.networkIdle || undefined,
  ].filter((value) => value !== undefined);
  if (given.length !== 1) {
    throw new Error('Give exactly one of text, ref, selector, url or networkIdle to wait for.');
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_WAIT_MS;
  if (timeoutMs > MAX_WAIT_MS) throw new Error(`timeoutMs is at most ${MAX_WAIT_MS} (a minute).`);
  if (args.text !== undefined) return { kind: 'text', text: args.text, timeoutMs };
  if (args.ref !== undefined) return { kind: 'ref', ref: args.ref, timeoutMs };
  if (args.selector !== undefined) return { kind: 'selector', selector: args.selector, timeoutMs };
  if (args.url !== undefined) {
    return { kind: 'url', url: args.url, glob: args.url.includes('*'), timeoutMs };
  }
  return { kind: 'network-idle', timeoutMs };
}

/** What a wait waits for, as a clause, and what holds once it has. */
function waitWords(plan: WaitPlan): { awaited: string; reached: string } {
  // The agent's own text, quoted, so it reads as what was asked for and nothing more.
  switch (plan.kind) {
    case 'text':
      return {
        awaited: `the text ${quoted(plan.text)} to be on the page`,
        reached: `The text ${quoted(plan.text)} is on the page.`,
      };
    case 'ref':
      return { awaited: `${plan.ref} to be visible`, reached: `${plan.ref} is visible.` };
    case 'selector':
      return {
        awaited: `an element matching ${quoted(plan.selector)} to be visible`,
        reached: `An element matching ${quoted(plan.selector)} is visible.`,
      };
    case 'url':
      return plan.glob
        ? {
            awaited: `the address to match ${quoted(plan.url)}`,
            reached: `The address matches ${quoted(plan.url)}.`,
          }
        : {
            awaited: `the address to contain ${quoted(plan.url)}`,
            reached: `The address contains ${quoted(plan.url)}.`,
          };
    case 'network-idle':
      return {
        awaited: "the page's network to go quiet",
        reached: "The page's network has gone quiet.",
      };
  }
}

/** Waits on the page as planned; resolves once it holds, or throws Playwright's timeout. */
async function runWait(page: Page, plan: WaitPlan): Promise<void> {
  const visible = { state: 'visible' as const, timeout: plan.timeoutMs };
  switch (plan.kind) {
    case 'text':
      return page.getByText(plan.text).first().waitFor(visible);
    case 'ref':
      return page.locator(`aria-ref=${plan.ref}`).waitFor(visible);
    case 'selector':
      return page.locator(plan.selector).first().waitFor(visible);
    case 'url':
      // A commit is enough: the address is what was asked about, not the load.
      return page.waitForURL(plan.glob ? plan.url : (url) => url.href.includes(plan.url), {
        timeout: plan.timeoutMs,
        waitUntil: 'commit',
      });
    case 'network-idle':
      return page.waitForLoadState('networkidle', { timeout: plan.timeoutMs });
  }
}

/**
 * `consola_browser_wait_for`: looking, like a snapshot, so it neither gives
 * way to the person nor takes the tab into the agent's hands.
 */
export function addWaitTool(
  server: McpServer,
  deps: BrowserActToolsDeps,
  access: CallerAccess,
): void {
  server.registerTool(
    'consola_browser_wait_for',
    {
      description:
        "Wait on one of your session's tabs for exactly one of: text to be on the page, an " +
        'element of your latest snapshot (ref) or a selector to be visible, the address to ' +
        "contain a text (or match a glob with *), or the page's network to go quiet. Waits " +
        `${DEFAULT_WAIT_MS / 1000} s unless timeoutMs says otherwise, at most ${MAX_WAIT_MS / 1000} s.`,
      inputSchema: {
        tabId: tabIdInput,
        text: z.string().min(1).optional().describe('Text to wait for on the page.'),
        ref: refInput.optional(),
        selector: z
          .string()
          .min(1)
          .optional()
          .describe(
            'A Playwright selector to wait for a visible match of: CSS by default, or text=…, ' +
              'role=…, xpath=….',
          ),
        url: z
          .string()
          .min(1)
          .optional()
          .describe('Text the address should contain, or a glob (with *) it should match.'),
        networkIdle: z
          .literal(true)
          .optional()
          .describe("Wait for the page's network to go quiet for half a second."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How long to wait, in ms: ${DEFAULT_WAIT_MS} unless given, at most ${MAX_WAIT_MS}.`,
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => answer(() => waitFor(deps, access, args)),
  );
}

async function waitFor(
  deps: BrowserActToolsDeps,
  access: CallerAccess,
  args: WaitArgs & { tabId: string },
): Promise<BrowserToolContent[]> {
  const tab = access.tab(args.tabId);
  const plan = planWait(args);
  refuseWhileDialog(deps.dialogs, tab.id);
  const words = waitWords(plan);
  const outcome = await access.stillAllowed(
    deps.driver.withPage(
      tab.id,
      async (page, control) => {
        const waited = (async () => {
          if (plan.kind === 'ref' && (await countOf(page.locator(`aria-ref=${plan.ref}`))) === 0) {
            throw new Error(staleRefMessage(plan.ref));
          }
          try {
            await runWait(page, plan);
          } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
              throw new Error(
                `Waited ${plan.timeoutMs / 1000} seconds for ${words.awaited}; it was not.`,
              );
            }
            throw pageStepFailure(error);
          }
        })();
        return unlessDialog(deps.dialogs, tab.id, control.signal, waited);
      },
      // Longer than the wait, so the wait's own timeout is what ends it.
      { deadlineMs: plan.timeoutMs + PAGE_CALL_TIMEOUT_MS },
    ),
  );
  if ('dialog' in outcome) {
    throw new PageTextError(
      openedDialogContent({ tabId: tab.id }, 'While it waited', outcome.dialog, '.'),
    );
  }
  return plain({ tabId: tab.id, summary: words.reached });
}
