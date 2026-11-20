/*
 * The title prompts below are adapted from t3code
 * (https://github.com/pingdotgg/t3code), used under the MIT License:
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ConversationRecord } from '../../shared/conversation';
import { MAX_TITLE_INSTRUCTIONS } from '../../shared/sessionTitles';
import { TITLE_INPUT_MAX } from './titleText';

/** The structured output every title call asks for. */
export const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
} as const;

const LENGTH_RULE = '- 3-8 words, fewer than 40 characters.';
const INSTRUCTIONS_RULE =
  "- Follow the user's title instructions at the end of this prompt. Where they conflict with these rules, including on length and format, they win.";
const INSTRUCTIONS_HEADING = 'Title instructions from the user:';
const TRUNCATED_MARKER = '[Earlier messages truncated]\n\n';

const INITIAL_TITLE_PROMPT = `Generate a title that will help the user recognize this Consola session weeks later.
Return JSON with the key title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- When asked about session behavior, never include the referenced titles' topics. "[Fix login] why didn't this session start?" means "Session Startup Failure". Use linked topics only for requests about that work.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when the message reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Never include the scope name (<scope>); the UI already shows it next to the title. Avoid quotes, labels, filler, and trailing punctuation.
- If the message only points at a PR or issue without describing it, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.

User message:
`;

const REGENERATE_TITLE_PROMPT = `Regenerate the title for an existing Consola session so the user can recognize it weeks later.
The previous title was <previous title, JSON-quoted>.
Return JSON with the key title.

Determine the title in this order:
1. Read the USER messages first. Identify the latest explicit durable goal. The original subject remains the subject until the user clearly changes what the session is about.
2. Use ASSISTANT messages to resolve vague links, unnamed code, and discovered product nouns. Do not promote one assistant finding into the session subject unless the user adopts it as a new goal.
3. Compare that subject with the previous title. Preserve accurate scope words, especially when earlier content is truncated. Replace the previous title when it is generic, artifact-based, a completion update, or contradicted by the session.
4. Title the durable subject and desired outcome, not the current workflow state.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Preserve the umbrella subject when later messages focus on one finding, provider, platform, or implementation detail.
- When asked about session behavior, never include the referenced titles' topics. "[Fix login] why didn't this session start?" means "Session Startup Failure". Use linked topics only for requests about that work.
- A session progressing through research, planning, implementation, review, CI, merge, and monitoring has usually not changed subjects.
- Ignore deliverables and operations such as mocks, plans, HTML, branches, PRs, tests, CI, commits, merging, and monitoring unless they are the actual topic.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- Treat final operational follow-ups and assistant completion summaries as weak evidence of subject.
- For reviews, name the reviewed feature or system and its durable concern, not one finding from the review.
- For research, name the question domain rather than the research process.
- Do not claim the work is complete.
- Do not copy and truncate a session message.
- Never include the scope name (<scope>); the UI already shows it next to the title. Avoid PR numbers, quotes, labels, filler, and trailing punctuation.
- If the session only points at a PR or issue without describing it, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.
- Keep the previous title unchanged if it is already accurate. Otherwise return a meaningfully improved title, not a cosmetic paraphrase.

Examples of the distinction:
- A subagent-monitoring review that finds a roster bug remains "Review Subagent Monitoring Risks," not "Roster Bug Review."
- A vague failing-test request later identified as a lazy feed mismatch becomes "Fix Lazy Feed Test," not "Prevent Mobile Feed Regressions."
- A QR-sharing overhaul that ends with CI and merge work remains about QR sharing, not the PR lifecycle.

Session contents:
`;

/** The first `max` code points of `text`. */
function firstChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('');
}

/** The last `max` code points of `text`. */
function lastChars(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(points.length - max).join('');
}

/** Trimmed, capped instructions; undefined when none are left. */
function instructionsOf(instructions: string | undefined): string | undefined {
  const kept = firstChars((instructions ?? '').trim(), MAX_TITLE_INSTRUCTIONS).trim();
  return kept || undefined;
}

/**
 * Fills the template's own placeholders. Done in one pass so a value cannot
 * be mistaken for a placeholder.
 */
function fillTemplate(template: string, scopeName: string, previousTitle?: string): string {
  return template.replace(/<scope>|<previous title, JSON-quoted>/g, (token) =>
    token === '<scope>' ? JSON.stringify(scopeName) : JSON.stringify(previousTitle ?? ''),
  );
}

/**
 * With instructions, swaps the length rule for the rule that lets them win.
 * Applied to the template only, before any user content is appended, so user
 * text can never change the rules.
 */
function ruleFor(template: string, instructions: string | undefined): string {
  return instructionsOf(instructions) ? template.replace(LENGTH_RULE, INSTRUCTIONS_RULE) : template;
}

/** The trailing block carrying the user's instructions, empty when there are none. */
function instructionsBlock(instructions: string | undefined): string {
  const kept = instructionsOf(instructions);
  return kept ? `\n\n${INSTRUCTIONS_HEADING}\n${kept}` : '';
}

export function buildInitialTitlePrompt(input: {
  message: string;
  scopeName: string;
  instructions?: string;
}): string {
  return (
    ruleFor(fillTemplate(INITIAL_TITLE_PROMPT, input.scopeName), input.instructions) +
    firstChars(input.message, TITLE_INPUT_MAX) +
    instructionsBlock(input.instructions)
  );
}

export function buildRegenerateTitlePrompt(input: {
  conversation: string;
  previousTitle: string;
  scopeName: string;
  instructions?: string;
}): string {
  return (
    ruleFor(
      fillTemplate(REGENERATE_TITLE_PROMPT, input.scopeName, input.previousTitle),
      input.instructions,
    ) +
    input.conversation +
    instructionsBlock(input.instructions)
  );
}

/**
 * The session's turns as `USER:` and `ASSISTANT:` lines. Tool steps are
 * dropped, and text on either side of a dropped step joins the same
 * ASSISTANT turn. Keeps the last 8,000 characters, with a marker, when the
 * conversation is longer or the record was truncated.
 */
export function formatConversationForTitle(record: ConversationRecord): string {
  const turns: string[] = [];
  let reply: string[] = [];
  const endReply = (): void => {
    if (reply.length > 0) turns.push(`ASSISTANT: ${reply.join('\n\n')}`);
    reply = [];
  };

  for (const entry of record.entries) {
    if (entry.kind === 'step') continue;
    if (entry.kind === 'text') {
      reply.push(entry.text);
      continue;
    }
    endReply();
    turns.push(`USER: ${entry.text}`);
  }
  endReply();

  const text = turns.join('\n\n');
  if (!record.truncated && Array.from(text).length <= TITLE_INPUT_MAX) return text;
  return TRUNCATED_MARKER + lastChars(text, TITLE_INPUT_MAX);
}
