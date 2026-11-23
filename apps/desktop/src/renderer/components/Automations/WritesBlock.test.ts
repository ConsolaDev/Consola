import * as fs from 'node:fs';
import * as path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WriteBlocks } from '../../../shared/automations';
import { WritesBlock } from './WritesBlock';

/*
 * The approval card's write block (the 3-B code review's F9): what a person
 * reads before allowing or approving an entry whose agents write. The words
 * are main's (`describeWrites`, tested in the engine); this pins that the
 * block shows every one of them, in order, and that both cards show it.
 */

// The engine's words, as text: the renderer imports the engine for its types only (`automationEngine.boundary.test.ts`).
const KEYCHAIN_SIGN_INS_SENTENCE =
  'Your keychain is another matter: Git, `gh` and Claude usually keep their sign-ins there.';
const KEYCHAIN_SENTENCE =
  'Its shell can ask macOS for your keychain items through `security` (macOS may or may not ask you first).';

const WRITES: WriteBlocks = {
  checkout:
    "Cuts `fix/<ticket>` from sprocket/catalog-portal's default branch, in a checkout of its own. Nothing else is written.",
  agents: [
    {
      agent: 'ui-bugfixer',
      head: 'ui-bugfixer · claude-work · sonnet · writes files and runs commands · environment sandboxed (sandbox, enforced on this Mac) · checked on Claude 2.1.330',
      sentences: [
        `Can change files only in this run's checkout. ${KEYCHAIN_SIGN_INS_SENTENCE} ${KEYCHAIN_SENTENCE}`,
      ],
    },
  ],
  commands: [
    '`pr` · on host, after ui-bugfixer: runs code an agent changed, as you, with your logins.',
    '`ticket` · on host, after ui-bugfixer: runs code an agent changed, as you, with your logins.',
  ],
  variables: 'Passes from your environment: CI.',
};

/** The markup's text, one entry per paragraph, entities read back. */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p class="([^"]+)">(.*?)<\/p>/g)].map(
    ([, kind, inner]) =>
      `${kind}: ${inner
        .replace(/<\/?strong>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')}`,
  );
}

describe('the approval card’s write block (3-B code review F9)', () => {
  it('shows every row main worded, in order, under "What it can change", the head in bold', () => {
    const html = renderToStaticMarkup(createElement(WritesBlock, { view: { writes: WRITES } }));
    expect(html).toMatch(
      /^<div class="automations-approval-writes" role="group" aria-label="What it can change">/,
    );
    expect(html).toContain(`<strong>${WRITES.agents[0].head}</strong>`);
    expect(paragraphs(html)).toEqual([
      `automations-approval-writes-checkout: ${WRITES.checkout}`,
      `automations-approval-writes-head: ${WRITES.agents[0].head}`,
      `automations-approval-writes-sentence: ${WRITES.agents[0].sentences[0]}`,
      `automations-approval-writes-command: ${WRITES.commands[0]}`,
      `automations-approval-writes-command: ${WRITES.commands[1]}`,
      `automations-approval-writes-variables: ${WRITES.variables}`,
    ]);
  });

  it('shows nothing for an entry that writes nothing', () => {
    expect(renderToStaticMarkup(createElement(WritesBlock, { view: {} }))).toBe('');
  });

  it('is on the Allow card and the run approval card', () => {
    const source = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');
    expect(source('AllowCard.tsx')).toContain('<WritesBlock view={automation} />');
    expect(source('StepsApprovalCard.tsx')).toContain('<WritesBlock view={ready} />');
  });
});
