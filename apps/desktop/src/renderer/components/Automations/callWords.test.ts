import { describe, expect, it } from 'vitest';
import type { CallFile, CallResultFile, StepRun } from '../../../shared/automations';
import {
  callHead,
  callRetryWarning,
  resultView,
  sentArgumentLine,
  sourceWords,
  stepKindLabel,
  trustLabel,
} from './callWords';

/** The engine's restart words (`steps/recover.ts`), which the renderer may not import. */
const INTERRUPTED_CALL =
  'Interrupted: Consola quit while this call was in flight. It may or may not have happened; check, then retry.';
const CALL_SETTLE_INTERRUPTED =
  "Consola quit while recording this call's result. It happened; check what it did, then retry.";

const AT = '2026-11-23T08:00:00.000Z';
const LATER = '2026-11-23T08:00:02.000Z';

function post(overrides: Partial<StepRun> = {}): StepRun {
  return { id: 'post', kind: 'uses', status: 'failed', attempt: 1, ...overrides };
}

const MAY = 'This call may already have happened; check before calling it again.';
const HAPPENED = 'This call already happened.';
const ERRORED =
  'The tool reported an error after it was called; it may have done part of its work. Check before calling it again.';

describe('stepKindLabel', () => {
  it('labels an agent step Agent, a command Command and a call Tool', () => {
    expect(stepKindLabel('agent')).toBe('Agent');
    expect(stepKindLabel('run')).toBe('Command');
    expect(stepKindLabel('uses')).toBe('Tool');
  });
});

describe('trustLabel and sourceWords', () => {
  it('labels each trust in the words the card and the detail share', () => {
    expect(trustLabel('literal')).toBe('(literal)');
    expect(trustLabel('trusted')).toBe('(trusted)');
    expect(trustLabel('untrusted')).toBe('(untrusted material)');
  });

  it('names each kind of source', () => {
    expect(sourceWords({ kind: 'artifact', step: 'brief', name: 'handover' })).toBe(
      "`brief`'s handover",
    );
    expect(sourceWords({ kind: 'artifact', step: 'shipped', name: 'output' })).toBe(
      "`shipped`'s `output`",
    );
    expect(sourceWords({ kind: 'output', step: 'triage', name: 'count', trusted: true })).toBe(
      "`triage`'s `count`",
    );
    expect(sourceWords({ kind: 'item', field: 'ts', trusted: false })).toBe(
      '`item.ts` (from the item)',
    );
    expect(sourceWords({ kind: 'previous', step: 'brief', name: 'handover' })).toBe(
      '`previous.brief.handover` (from the last run)',
    );
  });
});

describe('sentArgumentLine', () => {
  it('shows a templated argument as written, then what it sent, then its trust', () => {
    const line = sentArgumentLine({
      name: 'text',
      template: '{{steps.brief.handover}}',
      value: 'Shipped: empty carts at checkout.',
      trust: 'untrusted',
    });
    expect(line.line).toBe(
      '`text` = {{steps.brief.handover}} → Shipped: empty carts at checkout. (untrusted material)',
    );
    expect(line.value).toBe('Shipped: empty carts at checkout.');
    expect(line.long).toBe(false);
  });

  it('shows a literal once, with no template part', () => {
    expect(
      sentArgumentLine({
        name: 'channel',
        template: 'C0SUPPORT1',
        value: 'C0SUPPORT1',
        trust: 'literal',
      }).line,
    ).toBe('`channel` = C0SUPPORT1 (literal)');
  });

  it('keeps a trusted number a number', () => {
    expect(
      sentArgumentLine({
        name: 'limit',
        template: '{{steps.triage.count}}',
        value: 3,
        trust: 'trusted',
      }).line,
    ).toBe('`limit` = {{steps.triage.count}} → 3 (trusted)');
  });

  it('shows a nested value as its JSON, folded past three lines', () => {
    const template = [{ type: 'section', text: '*Brief:* {{steps.brief.handover}}' }];
    const value = [{ type: 'section', text: '*Brief:* Shipped.' }];
    const line = sentArgumentLine({ name: 'blocks', template, value, trust: 'untrusted' });
    expect(line.value).toBe(JSON.stringify(value, null, 2));
    expect(line.long).toBe(true);
    expect(line.line).toBe(
      `\`blocks\` = ${JSON.stringify(template)} → ${JSON.stringify(value, null, 2)} (untrusted material)`,
    );
    // Three lines or fewer reads inline.
    expect(
      sentArgumentLine({ name: 'by', template: { id: 7 }, value: { id: 7 }, trust: 'literal' })
        .long,
    ).toBe(false);
  });

  it('folds one line past 300 characters, and not at 300', () => {
    const at = (length: number) =>
      sentArgumentLine({ name: 'text', template: 'x', value: 'x'.repeat(length), trust: 'literal' })
        .long;
    expect(at(300)).toBe(false);
    expect(at(301)).toBe(true);
  });
});

describe('callRetryWarning', () => {
  it('says nothing for a call that sent nothing (its server was never reached)', () => {
    expect(
      callRetryWarning(
        post({ error: "Couldn't reach `slack`: spawn npx ENOENT. Nothing was sent." }),
      ),
    ).toBeNull();
    expect(callRetryWarning(post({ call: {} }))).toBeNull();
  });

  it('warns about an error the tool reported after it was called', () => {
    expect(
      callRetryWarning(
        post({
          error: '`slack#chat_post_message` failed: channel_not_found',
          call: { intentAt: AT, resultAt: LATER, isError: true },
        }),
      ),
    ).toBe(ERRORED);
  });

  it('warns that a timed-out call may already have happened', () => {
    expect(
      callRetryWarning(
        post({
          error: 'It may or may not have happened: the call timed out after 2s. Check, then retry.',
          call: { intentAt: AT },
        }),
      ),
    ).toBe(MAY);
  });

  it('says a call that landed already happened, outputs or not', () => {
    expect(
      callRetryWarning(
        post({
          error: 'It happened, but its result has no `ts`.',
          call: { intentAt: AT, resultAt: LATER, landed: true },
        }),
      ),
    ).toBe(HAPPENED);
  });

  it('reads the restart rows as the record left them', () => {
    expect(callRetryWarning(post({ error: INTERRUPTED_CALL, call: { intentAt: AT } }))).toBe(MAY);
    expect(
      callRetryWarning(
        post({ error: CALL_SETTLE_INTERRUPTED, call: { intentAt: AT, resultAt: LATER } }),
      ),
    ).toBe(HAPPENED);
  });

  it('says nothing for a step that is not a call', () => {
    expect(
      callRetryWarning({
        id: 'publish',
        kind: 'run',
        status: 'failed',
        attempt: 1,
        command: { envNames: [], intentAt: AT },
      }),
    ).toBeNull();
  });
});

describe('callHead', () => {
  const sent: CallFile = {
    server: 'slack',
    reached: 'started `/usr/local/bin/node /tmp/stub-mcp.cjs` on this Mac',
    tool: 'chat_post_message',
    arguments: [],
  };

  it('heads a dry run’s call Would have called', () => {
    expect(callHead({ ...sent, wouldHave: true }, post({ status: 'reported' }))).toEqual({
      heading: 'Would have called',
      reached: sent.reached,
      survivors: null,
    });
  });

  it('says how the tool was reached, and what survived it', () => {
    expect(callHead(sent, post({ status: 'completed' }))).toEqual({
      heading: null,
      reached: sent.reached,
      survivors: null,
    });
    expect(
      callHead(
        sent,
        post({
          call: { intentAt: AT, server: { pgid: 4100, startedAt: 'x', ended: true }, survivors: 1 },
        }),
      ),
    ).toEqual({
      heading: null,
      reached: sent.reached,
      survivors: 'Something it started was still running after it was stopped.',
    });
  });

  it('has nothing to head with no call.json', () => {
    expect(callHead(undefined, post({ status: 'failed' }))).toEqual({
      heading: null,
      reached: null,
      survivors: null,
    });
  });
});

describe('resultView', () => {
  it('reads an error result by its text', () => {
    const result: CallResultFile = {
      isError: true,
      bytes: 40,
      result: { content: [{ type: 'text', text: 'channel_not_found' }] },
    };
    expect(resultView(result)).toEqual({ state: 'error', text: 'channel_not_found' });
  });

  it('shows structured content as JSON before the text', () => {
    const result: CallResultFile = {
      isError: false,
      bytes: 80,
      result: {
        content: [{ type: 'text', text: '{"ts":"1700000000.0001"}' }],
        structuredContent: { ts: '1700000000.0001' },
      },
    };
    expect(resultView(result)).toEqual({
      state: 'ok',
      text: JSON.stringify({ ts: '1700000000.0001' }, null, 2),
    });
  });

  it('reads the text blocks of a result with no structured content, one per line', () => {
    expect(
      resultView({
        isError: false,
        bytes: 30,
        result: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
    ).toEqual({ state: 'ok', text: 'first\n[image]\nsecond' });
  });

  it('reads a Consola tool’s summary, then its data', () => {
    expect(
      resultView({
        isError: false,
        bytes: 12,
        summary: 'Removed 2 sessions.',
        result: { removed: 2 },
      }),
    ).toEqual({
      state: 'ok',
      text: `Removed 2 sessions.\n\n${JSON.stringify({ removed: 2 }, null, 2)}`,
    });
    expect(resultView({ isError: true, bytes: 9, summary: 'it broke' })).toEqual({
      state: 'error',
      text: 'it broke',
    });
  });

  it('keeps a cut result as the first part of its text', () => {
    expect(
      resultView({ isError: false, bytes: 3_000_000, cut: '{"content":[{"type":"te' }),
    ).toEqual({
      state: 'cut',
      text: '{"content":[{"type":"te',
    });
  });

  it('is none with no result.json', () => {
    expect(resultView(undefined)).toEqual({ state: 'none', text: '' });
  });
});
