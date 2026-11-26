import type { ConversationEntry, ConversationRecord } from '../../shared/conversation';
import { switchOpening } from '../../shared/workspace';
import type { Session } from '../../shared/workspace';
import type { ConversationOpening } from '../TerminalService';

/**
 * A conversation handed from one harness to another as a document the next
 * agent reads — the way across CLIs, whose transcripts nothing else shares.
 *
 * Written from the shape every driver reads its own transcripts into, so it
 * never knows which CLI either side runs. Kept well under what an agent can
 * read: past `MAX_HANDOFF_CHARS` the oldest entries go, but never the
 * opening prompts, which say what the work is for.
 */

export const MAX_HANDOFF_CHARS = 400_000;

export interface HandoffContext {
  sessionName: string;
  /** Harness names, as the person knows them. */
  from: string;
  to: string;
  /** Where the session works. */
  folder: string;
  switchedAt: Date;
  /** The handoff this conversation itself began from, when it did. */
  previous?: string;
}

function stamp(at: string | undefined): string {
  if (!at) return '';
  const time = new Date(at);
  return Number.isNaN(time.getTime())
    ? ''
    : ` · ${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function step(entry: Extract<ConversationEntry, { kind: 'step' }>): string {
  const detail = entry.detail ? ` ${entry.detail.replace(/`/g, "'")}` : '';
  return `- \`${entry.tool}\`${detail}${entry.failed ? ' — failed' : ''}`;
}

/**
 * Entries as markdown blocks, one per prompt or reply; a run of tool calls
 * is one block, a list under the reply that made them.
 */
function blocks(
  entries: ConversationEntry[],
): Array<{ block: string; kind: ConversationEntry['kind'] }> {
  const out: Array<{ block: string; kind: ConversationEntry['kind'] }> = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (entry.kind === 'step' && last?.kind === 'step') last.block += `\n${step(entry)}`;
    else if (entry.kind === 'step') out.push({ block: step(entry), kind: 'step' });
    else if (entry.kind === 'prompt') {
      out.push({ block: `## User${stamp(entry.at)}\n\n${entry.text.trim()}`, kind: 'prompt' });
    } else out.push({ block: `## Agent${stamp(entry.at)}\n\n${entry.text.trim()}`, kind: 'text' });
  }
  return out;
}

export function renderHandoff(record: ConversationRecord, context: HandoffContext): string {
  const all = blocks(record.entries);
  // The opening prompts always stay; then as many of the newest blocks as fit.
  const firstReply = all.findIndex((candidate) => candidate.kind !== 'prompt');
  const head = firstReply === -1 ? all : all.slice(0, firstReply);
  const rest = firstReply === -1 ? [] : all.slice(firstReply);
  let budget =
    MAX_HANDOFF_CHARS - head.reduce((sum, candidate) => sum + candidate.block.length + 2, 0);
  const kept: string[] = [];
  for (let index = rest.length - 1; index >= 0; index--) {
    const size = rest[index].block.length + 2;
    if (size > budget) break;
    budget -= size;
    kept.unshift(rest[index].block);
  }
  const truncated = record.truncated || kept.length < rest.length;

  const frontMatter = [
    '---',
    'consola-handoff: 1',
    `session: ${JSON.stringify(context.sessionName)}`,
    `from: ${JSON.stringify(context.from)}`,
    `to: ${JSON.stringify(context.to)}`,
    `switched: ${context.switchedAt.toISOString()}`,
    `folder: ${JSON.stringify(context.folder)}`,
    `previous: ${context.previous ? JSON.stringify(context.previous) : 'none'}`,
    `truncated: ${truncated}`,
    '---',
  ].join('\n');

  const intro = [
    `# Conversation handed over from ${context.from}`,
    '',
    `This session ran on ${context.from} until it switched to ${context.to}. What follows is that ` +
      'conversation, as history: the prompts, the replies, and the tools the agent used, without what ' +
      `those tools returned. The working folder (${context.folder}) may be further along than this describes.`,
    ...(context.previous
      ? ['', `It had itself been handed over before; the earlier part is in ${context.previous}.`]
      : []),
  ].join('\n');

  const omitted = truncated
    ? ['_Part of the middle of this conversation was too long to include._']
    : [];
  return (
    [frontMatter, intro, ...head.map((candidate) => candidate.block), ...omitted, ...kept].join(
      '\n\n',
    ) + '\n'
  );
}

/**
 * What the next agent is told first: generic, so it reads the same to any
 * CLI, and naming only the document, which says where it came from.
 */
export function handoffPrompt(documentPath: string): string {
  return (
    'This session continues a conversation that began with another agent. ' +
    `A transcript of it is saved at ${documentPath}: the prompts, the replies and the tools that agent used, ` +
    'without what those tools returned. Read all of it, then check the current state of the working folder, ' +
    'since the work may be partly done. Carry on from where it ends without redoing finished work; if the ' +
    'next step is unclear, summarise where things stand and ask me.'
  );
}

/**
 * How to open a session's current conversation if a launch finds it missing,
 * when a harness switch began it (`switchOpening`): the same fork again, or
 * the same handoff prompt. Undefined otherwise, and a missing conversation
 * then starts fresh as it always has.
 */
export function openingFor(session: Session): ConversationOpening | undefined {
  const opening = switchOpening(session);
  if (!opening) return undefined;
  return 'forkFrom' in opening
    ? { forkFrom: opening.forkFrom }
    : { prompt: handoffPrompt(opening.handoffPath) };
}
