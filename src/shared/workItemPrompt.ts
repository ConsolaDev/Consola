import type { InboxItem, WorkItemRef } from './workItems';
import { workItemUrl } from './workItems';

/**
 * Prompt rendering for work-item sessions.
 *
 * Shared because both sides render: main composes the seed prompt at launch,
 * and the settings panel previews the header above an editable body.
 */

/** "PR #51" / "Issue #87" — the title when the inbox holds no item. */
export function fallbackWorkItemTitle(ref: WorkItemRef): string {
  return ref.type === 'pr' ? `PR #${ref.number}` : `Issue #${ref.number}`;
}

/** Only these names are substituted; anything else in braces is left as typed. */
const PLACEHOLDER_PATTERN = /\{\{\s*(number|repo|title|url|type)\s*\}\}/g;

/**
 * Fill `{{number}} {{repo}} {{title}} {{url}} {{type}}` from the ref and, when
 * the inbox has one, the cached item. A template with no placeholders comes
 * back untouched, which is what lets a body be a bare slash command.
 */
export function substitutePlaceholders(template: string, ref: WorkItemRef, item?: InboxItem): string {
  const values: Record<string, string> = {
    number: String(ref.number),
    repo: ref.repo,
    title: item?.title ?? fallbackWorkItemTitle(ref),
    url: item?.url ?? workItemUrl(ref),
    type: ref.type === 'pr' ? 'pull request' : 'issue',
  };
  return template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => values[key]);
}

/** The provider's fixed context header for this item, rendered. */
export function renderSeedHeader(
  templates: Record<'pr' | 'issue', string>,
  ref: WorkItemRef,
  item?: InboxItem
): string {
  return substitutePlaceholders(templates[ref.type], ref, item);
}

export type WorkItemPromptResult =
  | { ok: true; seedPrompt: string }
  | { ok: false; message: string };

/**
 * The prompt seeded into a session started from an action.
 *
 * `header` arrives already rendered — the driver resolved its own template's
 * placeholders — and `body` is the action's raw template, so the two halves
 * cannot disagree about what `{{title}}` means. An empty or whitespace-only
 * rendered body is refused rather than seeding a session with nothing but
 * the header: the header says where the agent is, the body is the job.
 */
export function renderActionPrompt(
  header: string,
  body: string,
  ref: WorkItemRef,
  item?: InboxItem
): WorkItemPromptResult {
  const renderedBody = substitutePlaceholders(body, ref, item).trim();
  if (!renderedBody) {
    return { ok: false, message: 'This action has no prompt to send.' };
  }
  return { ok: true, seedPrompt: `${header}\n\n${renderedBody}` };
}
