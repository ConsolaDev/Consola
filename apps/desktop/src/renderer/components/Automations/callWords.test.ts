import { describe, expect, it } from 'vitest';
import type {
  CallArgument,
  CallFile,
  CallResultFile,
  CallView,
  ServerCheckView,
  ServerFacts,
  StepRun,
} from '../../../shared/automations';
import {
  callCardLines,
  callHead,
  callRetryWarning,
  cardArgumentLines,
  checkDialogLines,
  checkResultLines,
  serverLines,
  serversOf,
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

  it('labels a gate Gate and a loop Loop, as slice 3 labels them (merge)', () => {
    expect(stepKindLabel('gate')).toBe('Gate');
    expect(stepKindLabel('repeat')).toBe('Loop');
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

// --- Task 15: the cards, the servers, Check server -------------------------------------------

const ALLOW_LIST = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'LANG', 'LC_*', 'TMPDIR'];
const SLACK: ServerFacts = {
  name: 'slack',
  transport: 'stdio',
  target: 'npx -y @sprocket/slack-mcp@1.4.2',
  environment: [...ALLOW_LIST, 'SLACK_TEAM_ID', 'SLACK_BOT_TOKEN'],
  launcher: true,
  secrets: ['SLACK_BOT_TOKEN'],
};
const TRACKER: ServerFacts = {
  name: 'tracker',
  transport: 'http',
  target: 'https://mcp.tracker.sprocket.example/mcp',
  secretHeaders: [{ header: 'Authorization', secrets: ['TRACKER_TOKEN'] }],
  secrets: ['TRACKER_TOKEN'],
};
const STARTED = 'Started for each call and stopped after.';
const NPX_NOTE =
  'A pinned version still fetches its dependencies when it starts; an installed program by absolute path does not.';
const UNPINNED = 'This runs the newest version at every call, unattended; pin one.';
const SLACK_LINE =
  'starts `npx -y @sprocket/slack-mcp@1.4.2` on this Mac as you, with your files and network, in an empty folder, with HOME, USER, LOGNAME, SHELL, PATH, TERM, LANG, LC_*, TMPDIR, SLACK_TEAM_ID and SLACK_BOT_TOKEN';

const HANDOVER: CallArgument = {
  name: 'text',
  template: '{{steps.brief.handover}}',
  trust: 'untrusted',
  sources: [{ kind: 'artifact', step: 'brief', name: 'handover' }],
};
const CHANNEL: CallArgument = {
  name: 'channel',
  template: 'C0SUPPORT1',
  trust: 'literal',
  sources: [],
};
const POST: CallView = {
  ref: 'slack#chat_post_message',
  server: 'slack',
  tool: 'chat_post_message',
  arguments: [CHANNEL, HANDOVER],
  facts: SLACK,
};

describe('cardArgumentLines', () => {
  it('names where each argument comes from, never a value, with its trust', () => {
    expect(cardArgumentLines(HANDOVER)).toEqual([
      "`text` ← `brief`'s handover (untrusted material)",
    ]);
    expect(cardArgumentLines(CHANNEL)).toEqual(['`channel` = C0SUPPORT1 (literal)']);
    expect(
      cardArgumentLines({
        name: 'limit',
        template: '{{steps.triage.count}}',
        trust: 'trusted',
        sources: [{ kind: 'output', step: 'triage', name: 'count', trusted: true }],
      }),
    ).toEqual(["`limit` ← `triage`'s `count` (trusted)"]);
    expect(
      cardArgumentLines({
        name: 'blocks',
        template: [{ type: 'section', text: '*Brief:* {{steps.brief.handover}} {{item.title}}' }],
        trust: 'untrusted',
        sources: [
          { kind: 'artifact', step: 'brief', name: 'handover' },
          { kind: 'item', field: 'title', trusted: false },
        ],
      }),
    ).toEqual(["`blocks` ← `brief`'s handover, `item.title` (from the item) (untrusted material)"]);
    expect(
      cardArgumentLines({
        name: 'prior',
        template: '{{previous.brief.handover}}',
        trust: 'untrusted',
        sources: [{ kind: 'previous', step: 'brief', name: 'handover' }],
      }),
    ).toEqual(['`prior` ← `previous.brief.handover` (from the last run) (untrusted material)']);
    // A literal that is not text reads as its JSON.
    expect(
      cardArgumentLines({ name: 'pr_states', template: ['merged'], trust: 'literal', sources: [] }),
    ).toEqual(['`pr_states` = ["merged"] (literal)']);
  });

  it('puts an interpreted argument’s notice under it', () => {
    const notice =
      '`jql` gets text someone else wrote; a tool may run it as a query or open what it names. Check that this is what you mean.';
    expect(
      cardArgumentLines({
        name: 'jql',
        template: 'project = CAT AND text ~ "{{item.title}}"',
        trust: 'untrusted',
        sources: [{ kind: 'item', field: 'title', trusted: false }],
        notice,
      }),
    ).toEqual(['`jql` ← `item.title` (from the item) (untrusted material)', notice]);
  });
});

describe('callCardLines', () => {
  it('gives the briefing’s post: its ref, its arguments, its outputs', () => {
    expect(callCardLines(POST, ['ts'])).toEqual([
      'Calls `slack#chat_post_message`',
      '`channel` = C0SUPPORT1 (literal)',
      "`text` ← `brief`'s handover (untrusted material)",
      'Outputs: ts',
    ]);
  });

  it('says a call marked dry_run: run also runs in a dry run', () => {
    expect(
      callCardLines(
        {
          ...POST,
          ref: 'slack#conversations_history',
          tool: 'conversations_history',
          arguments: [CHANNEL],
          alsoInDryRun: true,
        },
        [],
      ),
    ).toEqual([
      'Calls `slack#conversations_history`',
      '`channel` = C0SUPPORT1 (literal)',
      'also runs in a dry run',
    ]);
  });

  it('says a destructive Consola tool acts on what is true when it runs', () => {
    expect(
      callCardLines(
        {
          ref: 'consola#cleanup_stale_sessions',
          server: 'consola',
          tool: 'cleanup_stale_sessions',
          arguments: [{ name: 'pr_states', template: ['merged'], trust: 'literal', sources: [] }],
          destructive: true,
        },
        [],
      ),
    ).toEqual([
      'Calls `consola#cleanup_stale_sessions`',
      '`pr_states` = ["merged"] (literal)',
      'It acts on what is true when this step runs; approving the run does not approve a list.',
    ]);
  });
});

describe('serversOf', () => {
  it('lists each factory server the calls use once, in step order, and no Consola one', () => {
    const consola: CallView = {
      ref: 'consola#cleanup_stale_sessions',
      server: 'consola',
      tool: 'cleanup_stale_sessions',
      arguments: [],
    };
    const lookup: CallView = { ...POST, ref: 'tracker#lookup', server: 'tracker', facts: TRACKER };
    expect(
      serversOf([consola, POST, lookup, { ...POST, ref: 'slack#conversations_history' }]),
    ).toEqual([SLACK, TRACKER]);
    expect(serversOf([consola])).toEqual([]);
  });
});

describe('serverLines', () => {
  it('says a pinned npx server starts as you, with its environment by name, and notes its dependencies', () => {
    expect(serverLines(SLACK)).toEqual([SLACK_LINE, STARTED, NPX_NOTE]);
  });

  it('warns about an unpinned package after the note', () => {
    expect(serverLines({ ...SLACK, target: 'npx -y @sprocket/slack-mcp', unpinned: true })).toEqual(
      [
        SLACK_LINE.replace('@sprocket/slack-mcp@1.4.2', '@sprocket/slack-mcp'),
        STARTED,
        NPX_NOTE,
        UNPINNED,
      ],
    );
  });

  it('says a remote server is called, with the headers its secrets make', () => {
    expect(serverLines(TRACKER)).toEqual([
      'calls https://mcp.tracker.sprocket.example/mcp with an `Authorization` header made from TRACKER_TOKEN',
      STARTED,
    ]);
    expect(
      serverLines({
        ...TRACKER,
        secretHeaders: [
          { header: 'Authorization', secrets: ['TRACKER_TOKEN'] },
          { header: 'X-Team', secrets: ['TEAM_TOKEN', 'TRACKER_TOKEN'] },
        ],
        secrets: ['TRACKER_TOKEN', 'TEAM_TOKEN'],
      })[0],
    ).toBe(
      'calls https://mcp.tracker.sprocket.example/mcp with `Authorization` and `X-Team` headers made from TRACKER_TOKEN and TEAM_TOKEN',
    );
    expect(
      serverLines({ name: 'docs', transport: 'http', target: 'https://docs.sprocket.example/mcp' }),
    ).toEqual(['calls https://docs.sprocket.example/mcp', STARTED]);
  });

  it('shows each literal env: pair as written, after what it starts (review S1)', () => {
    expect(
      serverLines({
        ...SLACK,
        environment: [...ALLOW_LIST, 'SLACK_TEAM_ID', 'HTTPS_PROXY', 'SLACK_BOT_TOKEN'],
        env: [
          { name: 'SLACK_TEAM_ID', value: 'T0SPROCKET' },
          { name: 'HTTPS_PROXY', value: 'http://elsewhere:8080' },
        ],
      }),
    ).toEqual([
      SLACK_LINE.replace('SLACK_TEAM_ID and', 'SLACK_TEAM_ID, HTTPS_PROXY and'),
      'env: `SLACK_TEAM_ID=T0SPROCKET`',
      'env: `HTTPS_PROXY=http://elsewhere:8080`',
      STARTED,
      NPX_NOTE,
    ]);
  });

  it("shows every header as written: a literal whole, a secret's as its template (review S1)", () => {
    expect(
      serverLines({
        ...TRACKER,
        headers: [
          { name: 'Authorization', value: 'Bearer ${TRACKER_TOKEN}' },
          { name: 'X-Forward-To', value: 'https://elsewhere.example/hook' },
        ],
      }),
    ).toEqual([
      'calls https://mcp.tracker.sprocket.example/mcp with an `Authorization` header made from TRACKER_TOKEN',
      'header: `Authorization: Bearer ${TRACKER_TOKEN}`',
      'header: `X-Forward-To: https://elsewhere.example/hook`',
      STARTED,
    ]);
  });

  it('gives a program by absolute path no dependency note', () => {
    expect(
      serverLines({
        name: 'slack',
        transport: 'stdio',
        target: '/usr/local/bin/slack-mcp --stdio',
        environment: ALLOW_LIST,
      }),
    ).toEqual([
      'starts `/usr/local/bin/slack-mcp --stdio` on this Mac as you, with your files and network, in an empty folder, with HOME, USER, LOGNAME, SHELL, PATH, TERM, LANG, LC_* and TMPDIR',
      STARTED,
    ]);
  });
});

describe('Check server', () => {
  it('asks before it starts the server, showing what it starts', () => {
    expect(checkDialogLines(SLACK)).toEqual({
      title: 'Check `slack`?',
      lines: [
        SLACK_LINE,
        'Consola starts it once, lists its tools and stops it. It calls no tool.',
      ],
    });
  });

  it("shows the server's definition in full: its literal env: and headers, a secret's header as its template (review S1)", () => {
    expect(
      checkDialogLines({
        ...SLACK,
        env: [{ name: 'HTTPS_PROXY', value: 'http://elsewhere:8080' }],
      }).lines,
    ).toEqual([
      SLACK_LINE,
      'env: `HTTPS_PROXY=http://elsewhere:8080`',
      'Consola starts it once, lists its tools and stops it. It calls no tool.',
    ]);
    expect(
      checkDialogLines({
        ...TRACKER,
        headers: [
          { name: 'Authorization', value: 'Bearer ${TRACKER_TOKEN}' },
          { name: 'X-Forward-To', value: 'https://elsewhere.example/hook' },
        ],
      }).lines,
    ).toEqual([
      'calls https://mcp.tracker.sprocket.example/mcp with an `Authorization` header made from TRACKER_TOKEN',
      'header: `Authorization: Bearer ${TRACKER_TOKEN}`',
      'header: `X-Forward-To: https://elsewhere.example/hook`',
      'Consola starts it once, lists its tools and stops it. It calls no tool.',
    ]);
  });

  const view = (overrides: Partial<ServerCheckView>): ServerCheckView => ({
    server: 'slack',
    at: '2026-11-23T08:00:00.000Z',
    steps: [],
    ...overrides,
  });

  it('says what it found, step by step', () => {
    expect(
      checkResultLines(
        view({
          tools: ['chat_post_message', 'conversations_history', 'slow_post', 'post_then_fail'],
          steps: [
            { step: 'post', tool: 'chat_post_message', verdict: 'fits' },
            { step: 'history', tool: 'search', verdict: 'missing' },
            {
              step: 'later',
              tool: 'chat_post_message',
              verdict: { problem: 'channel: must be string' },
            },
          ],
        }),
        { timeZone: 'UTC' },
      ),
    ).toEqual([
      'Checked 23 Nov 08:00: 4 tools.',
      '`post`: `chat_post_message` is there, and its literal values fit',
      '`history`: `slack` has no `search`',
      '`later`: channel: must be string',
    ]);
    expect(checkResultLines(view({ tools: ['one'] }), { timeZone: 'UTC' })).toEqual([
      'Checked 23 Nov 08:00: 1 tool.',
    ]);
  });

  it('says why it could not check, and what survived it', () => {
    expect(
      checkResultLines(
        view({ problem: "Couldn't reach `slack`: spawn /nowhere ENOENT.", survivors: 1 }),
        { timeZone: 'UTC' },
      ),
    ).toEqual([
      "Checked 23 Nov 08:00: Couldn't reach `slack`: spawn /nowhere ENOENT.",
      'Something it started was still running after it was stopped.',
    ]);
  });
});
