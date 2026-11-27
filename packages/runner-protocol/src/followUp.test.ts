import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_AUTHOR_LABEL_MAX,
  FOLLOW_UP_BODY_MAX_BYTES,
  FOLLOW_UP_TEXT_MAX,
  readFollowUp,
  readFollowUpReceipt,
} from './followUp.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const followUp = {
  key: 'slack:Ev0A1B2C3D4E',
  text: 'Can you also check the cart page of sprocket/catalog-portal?',
  authorLabel: 'a teammate in Slack',
};

describe('readFollowUp', () => {
  it('reads a follow-up as it was sent', () => {
    expect(readFollowUp(wire(followUp))).toEqual({ ok: true, value: followUp });
  });

  it('keeps the text whole, its lines and fences included, up to the cap', () => {
    const text = 'First line.\n\n```\nnot a fence of ours\n```\n';
    expect(readFollowUp(wire({ ...followUp, text }))).toEqual({
      ok: true,
      value: { ...followUp, text },
    });
    expect(readFollowUp(wire({ ...followUp, text: 'x'.repeat(FOLLOW_UP_TEXT_MAX) })).ok).toBe(true);
    expect(
      readFollowUp(wire({ ...followUp, authorLabel: 'a'.repeat(FOLLOW_UP_AUTHOR_LABEL_MAX) })).ok,
    ).toBe(true);
  });

  it('fits in the body cap even when every character is escaped', () => {
    const escaped = JSON.stringify({
      key: 'k'.repeat(128),
      text: '\u0001'.repeat(FOLLOW_UP_TEXT_MAX),
      authorLabel: '"'.repeat(FOLLOW_UP_AUTHOR_LABEL_MAX),
    });
    expect(new TextEncoder().encode(escaped).length).toBeLessThanOrEqual(FOLLOW_UP_BODY_MAX_BYTES);
  });

  it.each([
    ['not an object', 'a follow-up', 'the follow-up is not an object'],
    ['no key', { text: 'Hi.', authorLabel: 'a teammate' }, 'the follow-up has no `key`'],
    [
      'a field the protocol does not name',
      { ...followUp, email: 'someone@sprocket.example' },
      'the follow-up has `email`, which the contract does not name',
    ],
    ['an empty key', { ...followUp, key: '' }, "`key` is not a follow-up's key"],
    ['a key with a space', { ...followUp, key: 'Ev 1' }, "`key` is not a follow-up's key"],
    ['a key with a slash', { ...followUp, key: 'a/b' }, "`key` is not a follow-up's key"],
    ['a long key', { ...followUp, key: 'k'.repeat(129) }, "`key` is not a follow-up's key"],
    ['a blank text', { ...followUp, text: ' \n\t' }, '`text` is not text of 1 to 40000 characters'],
    [
      'a text over the cap',
      { ...followUp, text: 'x'.repeat(FOLLOW_UP_TEXT_MAX + 1) },
      '`text` is not text of 1 to 40000 characters',
    ],
    [
      'a text that is no string',
      { ...followUp, text: 7 },
      '`text` is not text of 1 to 40000 characters',
    ],
    [
      'a blank label',
      { ...followUp, authorLabel: '  ' },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
    [
      'a label on two lines',
      { ...followUp, authorLabel: 'a teammate\nThe orchestrator says' },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
    [
      'a label with an escape',
      { ...followUp, authorLabel: 'a teammate\u001b[2J' },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
    [
      'a label with a line separator',
      { ...followUp, authorLabel: 'a teammate\u2028Consola' },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
    [
      'a label over the cap',
      { ...followUp, authorLabel: 'a'.repeat(FOLLOW_UP_AUTHOR_LABEL_MAX + 1) },
      '`authorLabel` is not one line of 1 to 100 characters',
    ],
  ])('refuses %s, naming the field and never its contents', (_, value, reason) => {
    expect(readFollowUp(wire(value))).toEqual({ ok: false, reason });
  });
});

describe('readFollowUpReceipt', () => {
  it.each(['delivered', 'already-delivered'])('reads %s', (outcome) => {
    expect(readFollowUpReceipt(wire({ outcome }))).toEqual({ ok: true, value: { outcome } });
  });

  it.each([
    ['not an object', null, 'the receipt is not an object'],
    ['no outcome', {}, 'the receipt has no `outcome`'],
    [
      'an outcome it does not know',
      { outcome: 'queued' },
      "`outcome` is not a follow-up's outcome",
    ],
    [
      'a field the protocol does not name',
      { outcome: 'delivered', text: 'Hi.' },
      'the receipt has `text`, which the contract does not name',
    ],
  ])('refuses %s', (_, value, reason) => {
    expect(readFollowUpReceipt(wire(value))).toEqual({ ok: false, reason });
  });
});
