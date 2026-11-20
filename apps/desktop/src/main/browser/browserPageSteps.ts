import type { Page } from 'playwright-core';
import { z } from 'zod';
import { aDialog, PageTextError, type ToolDialogs } from './browserToolAccess';
import { type BrowserToolContent, firstLine, untrusted, untrustedJson } from './browserToolResults';
import type { HeldDialog } from './PageDialogs';
import type { PageDriver } from './PageDriver';
import type { PersonInput } from './PersonInput';

/*
 * What the tools that run in a page share: `consola_browser_act` and
 * `_evaluate` (browserActTools), `_wait_for` (browserWaitTool) and
 * `_dialog` (browserDialogTool).
 */

/** What the acting tools need besides the caller's access. */
export interface BrowserActToolsDeps {
  driver: Pick<PageDriver, 'withPage'>;
  person: Pick<PersonInput, 'refusal' | 'noteAgentUse'>;
  dialogs: ToolDialogs;
}

/** A ref from a snapshot's outline (`e5`, or `f1e5` inside a frame), and nothing that could be a selector. */
const REF_PATTERN = /^(f\d+)?e\d+$/;
export const refInput = z
  .string()
  .regex(REF_PATTERN, 'A ref is the [ref=…] of an element in your latest snapshot, like e5.')
  .describe('The ref of an element in your latest snapshot of this tab, like e5.');

export function staleRefMessage(ref: string): string {
  return `There is no element ${ref} on the page now; take a new snapshot (consola_browser_snapshot) for current refs.`;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failure's first line, without Playwright's `locator.waitFor: ` and `Error: ` in front. */
function firstLineOf(error: unknown): string {
  return firstLine(messageOf(error))
    .replace(/^[a-zA-Z.]+: /, '')
    .replace(/^Error: /, '');
}

/**
 * A step on the page that failed, for any reason but one these tools word
 * themselves: its first line only, after the untrusted note. Playwright's text
 * echoes the page's (an exception's message, a selector, the markup its call
 * log quotes), and the agent reading it has a shell (Invariant 7).
 */
export function pageStepFailure(error: unknown): PageTextError {
  return new PageTextError([untrusted(firstLineOf(error) || 'The step failed on the page.')]);
}

/** How many elements a locator finds now; a failure is a page step's like any other. */
export async function countOf(locator: ReturnType<Page['locator']>): Promise<number> {
  try {
    return await locator.count();
  } catch (error) {
    throw pageStepFailure(error);
  }
}

/**
 * What `work` gives, or the dialog the page opens first. A page showing a
 * dialog answers nothing until it is answered, so a call that waits on it
 * returns at once with the dialog instead; `work` is left to finish whenever
 * the dialog is answered, and its call has ended by then (`signal`).
 */
export async function unlessDialog<T>(
  dialogs: ToolDialogs,
  tabId: string,
  signal: AbortSignal,
  work: Promise<T>,
): Promise<{ done: T } | { dialog: HeldDialog }> {
  work.catch(() => {});
  return Promise.race([
    work.then((done) => ({ done })),
    dialogs.opened(tabId, signal).then((dialog) => ({ dialog })),
  ]);
}

/** A dialog opened while a call ran, said after the note (its message is the page's). */
export function openedDialogContent(
  fields: Record<string, unknown>,
  when: string,
  dialog: HeldDialog,
  then: string,
): BrowserToolContent[] {
  const summary = `${when}, the page opened ${aDialog(dialog)} and waits for an answer; answer it with consola_browser_dialog${then}`;
  return [untrustedJson({ ...fields, summary, pendingDialog: dialog })];
}
