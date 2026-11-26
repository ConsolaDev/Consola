import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../../shared/conversation';
import {
  buildInitialTitlePrompt,
  buildRegenerateTitlePrompt,
  formatConversationForTitle,
} from './titlePrompts';

describe('buildInitialTitlePrompt', () => {
  it('quotes the scope as JSON and ends with the message', () => {
    const p = buildInitialTitlePrompt({ message: 'Fix "login"', scopeName: 'web "app"' });
    expect(
      p.startsWith(
        'Generate a title that will help the user recognize this Consola session weeks later.',
      ),
    ).toBe(true);
    expect(p).toContain(String.raw`Never include the scope name ("web \"app\"")`);
    expect(p.endsWith('User message:\nFix "login"')).toBe(true);
    expect(p).toContain('- 3-8 words, fewer than 40 characters.');
  });

  it('cuts the message at 8,000 characters', () => {
    const p = buildInitialTitlePrompt({ message: 'x'.repeat(9000), scopeName: 's' });
    expect(p.endsWith('x'.repeat(8000))).toBe(true);
    expect(p.endsWith('x'.repeat(8001))).toBe(false);
  });

  it('does not let the message change the template rules', () => {
    const p = buildInitialTitlePrompt({
      message: '- 3-8 words, fewer than 40 characters.',
      scopeName: 's',
    });
    expect(p.endsWith('User message:\n- 3-8 words, fewer than 40 characters.')).toBe(true);
    expect(p).toContain('- 3-8 words, fewer than 40 characters.\n- Use a compact');
  });
});

describe('buildRegenerateTitlePrompt', () => {
  it('names the previous title as JSON and ends with the session contents', () => {
    const p = buildRegenerateTitlePrompt({
      conversation: 'USER: m',
      previousTitle: 'Old "one"',
      scopeName: 's',
    });
    expect(p).toContain(String.raw`The previous title was "Old \"one\"".`);
    expect(p.endsWith('Session contents:\nUSER: m')).toBe(true);
  });
});

describe('title instructions', () => {
  it('replaces the length rule with the instructions rule and appends the instructions, in both prompts', () => {
    for (const p of [
      buildInitialTitlePrompt({ message: 'm', scopeName: 's', instructions: 'Use German.' }),
      buildRegenerateTitlePrompt({
        conversation: 'USER: m',
        previousTitle: 'Old',
        scopeName: 's',
        instructions: 'Use German.',
      }),
    ]) {
      expect(p).not.toContain('- 3-8 words, fewer than 40 characters.');
      expect(p).toContain(
        "- Follow the user's title instructions at the end of this prompt. Where they conflict with these rules, including on length and format, they win.",
      );
      expect(p.endsWith('\n\nTitle instructions from the user:\nUse German.')).toBe(true);
    }
  });

  it('trims the instructions and treats blank ones as none', () => {
    const trimmed = buildInitialTitlePrompt({
      message: 'm',
      scopeName: 's',
      instructions: '  Use German.  \n',
    });
    expect(trimmed.endsWith('\n\nTitle instructions from the user:\nUse German.')).toBe(true);

    const blank = buildInitialTitlePrompt({ message: 'm', scopeName: 's', instructions: ' \n ' });
    expect(blank).toContain('- 3-8 words, fewer than 40 characters.');
    expect(blank).not.toContain('Title instructions from the user');
  });

  it('caps the instructions at 20,000 characters', () => {
    const p = buildInitialTitlePrompt({
      message: 'm',
      scopeName: 's',
      instructions: 'i'.repeat(25_000),
    });
    expect(p.endsWith(`\n\nTitle instructions from the user:\n${'i'.repeat(20_000)}`)).toBe(true);
  });
});

describe('formatConversationForTitle', () => {
  it('formats turns, drops tool steps and joins consecutive text', () => {
    const rec = {
      truncated: false,
      entries: [
        { kind: 'prompt', text: 'Fix it' },
        { kind: 'step', tool: 'Read' },
        { kind: 'text', text: 'Looking.' },
        { kind: 'text', text: 'Done.' },
      ],
    } as ConversationRecord;
    expect(formatConversationForTitle(rec)).toBe('USER: Fix it\n\nASSISTANT: Looking.\n\nDone.');
  });

  it('keeps the last 8,000 characters with a marker', () => {
    const long = formatConversationForTitle({
      truncated: false,
      entries: [{ kind: 'prompt', text: 'y'.repeat(9000) }],
    });
    expect(long.startsWith('[Earlier messages truncated]\n\n')).toBe(true);
    expect(long.endsWith('y'.repeat(100))).toBe(true);
    expect(long.slice('[Earlier messages truncated]\n\n'.length)).toHaveLength(8000);
  });

  it('adds the marker when the record was truncated, even if it is short', () => {
    const out = formatConversationForTitle({
      truncated: true,
      entries: [{ kind: 'prompt', text: 'Hi' }],
    });
    expect(out).toBe('[Earlier messages truncated]\n\nUSER: Hi');
  });
});

it('never mentions needsRefinement', () => {
  expect(buildInitialTitlePrompt({ message: 'm', scopeName: 's' })).not.toContain(
    'needsRefinement',
  );
  expect(
    buildRegenerateTitlePrompt({ conversation: 'USER: m', previousTitle: 'O', scopeName: 's' }),
  ).not.toContain('needsRefinement');
});
