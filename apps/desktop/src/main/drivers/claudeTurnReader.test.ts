import { describe, expect, it } from 'vitest';
import {
  CLAUDE_SIGN_IN_HINT,
  createClaudeTurnReader,
  MAX_JSON_RETRIES,
  MAX_LINE_CHARS,
  MAX_OTHER_LINES,
  MAX_PENDING_CHARS,
} from './claudeTurnReader';
import type { TurnEvent } from './HarnessDriver';
import {
  ASSISTANT_RATE_LIMIT,
  INIT,
  jsonLine,
  RATE_LIMIT_REJECTED,
  RESULT_AUTH,
  RESULT_MAX_TURNS,
  RESULT_OK,
  resultLine,
  TOOL_USE,
} from './streamJson.test-helpers';

/** Every event of `chunks`, fed in order, then `end()`'s. */
function readAll(...chunks: string[]) {
  const reader = createClaudeTurnReader();
  const events: TurnEvent[] = [];
  for (const chunk of chunks) events.push(...reader.push(chunk));
  const { events: last, report } = reader.end();
  return { events: [...events, ...last], report };
}

const lines = (events: TurnEvent[]) => events.filter((event) => event.kind === 'line');

describe('createClaudeTurnReader', () => {
  it('reads init, a tool call and the result', () => {
    const reader = createClaudeTurnReader();
    const events = reader.push(INIT + TOOL_USE + RESULT_OK);
    expect(events).toEqual([
      {
        kind: 'init',
        init: {
          model: 'claude-opus-5-5',
          servers: [{ name: 'consola', status: 'connected' }],
          signInHint: CLAUDE_SIGN_IN_HINT,
          raw: JSON.parse(INIT),
        },
      },
      { kind: 'tool', name: 'mcp__consola__consola_set_outputs' },
    ]);
    const { events: last, report } = reader.end();
    expect(last).toEqual([]);
    expect(report.result).toEqual({
      subtype: 'success',
      isError: false,
      costUsd: 0.0412,
      turns: 7,
      text: 'FINDINGS: done',
      deniedTools: [],
      raw: JSON.parse(RESULT_OK),
    });
    expect(report.init?.model).toBe('claude-opus-5-5');
    expect(report.init?.servers).toEqual([{ name: 'consola', status: 'connected' }]);
    expect(report.init?.signInHint).toBe(CLAUDE_SIGN_IN_HINT);
    expect(report.otherLines).toEqual([]);
    expect(report.limitNotice).toBe(false);
    expect(report).not.toHaveProperty('maxTurns');
  });

  it('joins a line split anywhere', () => {
    for (let at = 1; at < RESULT_OK.length; at++) {
      const reader = createClaudeTurnReader();
      const events = [...reader.push(RESULT_OK.slice(0, at)), ...reader.push(RESULT_OK.slice(at))];
      expect(lines(events)).toEqual([]);
      const { events: last, report } = reader.end();
      expect(last).toEqual([]);
      expect(report.result).toMatchObject({ costUsd: 0.0412, turns: 7, isError: false });
      expect(report.otherLines).toEqual([]);
    }
  });

  it('joins a \\r\\n split between chunks', () => {
    const line = RESULT_OK.replace('\n', '\r\n');
    const { events, report } = readAll(line.slice(0, -1), line.slice(-1));
    expect(lines(events)).toEqual([]);
    expect(report.result?.turns).toBe(7);
  });

  it('reads three lines from one chunk, and a line over three chunks', () => {
    const reader = createClaudeTurnReader();
    expect(reader.push(INIT + TOOL_USE + TOOL_USE).map((event) => event.kind)).toEqual([
      'init',
      'tool',
      'tool',
    ]);
    const third = Math.floor(RESULT_AUTH.length / 3);
    expect(reader.push(RESULT_AUTH.slice(0, third))).toEqual([]);
    expect(reader.push(RESULT_AUTH.slice(third, 2 * third))).toEqual([]);
    expect(reader.push(RESULT_AUTH.slice(2 * third))).toEqual([]);
    expect(reader.end().report.result?.text).toBe('Not logged in · Please run /login');
  });

  it('strips escapes around a line before parsing', () => {
    const reader = createClaudeTurnReader();
    expect(reader.push(`\x1b[2K${INIT.replace('\n', '\r\n')}`)).toMatchObject([{ kind: 'init' }]);
    expect(reader.push('\x1b[?25h\r\n')).toEqual([{ kind: 'line', text: '\x1b[?25h' }]);
    expect(reader.push(`\x1b[1m${RESULT_OK.replace('\n', '\x1b[0m\r\n')}`)).toEqual([]);
    const { report } = reader.end();
    expect(report.otherLines).toEqual([]);
    expect(report.result?.turns).toBe(7);
  });

  it('keeps what is not JSON', () => {
    const { events, report } = readAll(
      'Warning: MCP server blocked by enterprise policy: srvb\r\n',
      '[1,2]\n',
      '{"no":"type"}\n',
      '{"type":7}\n',
    );
    expect(events).toEqual([
      { kind: 'line', text: 'Warning: MCP server blocked by enterprise policy: srvb' },
      { kind: 'line', text: '[1,2]' },
      { kind: 'line', text: '{"no":"type"}' },
      { kind: 'line', text: '{"type":7}' },
    ]);
    expect(report.otherLines).toEqual([
      'Warning: MCP server blocked by enterprise policy: srvb',
      '[1,2]',
      '{"no":"type"}',
      '{"type":7}',
    ]);
    expect(report.result).toBeUndefined();
    expect(report.init).toBeUndefined();
  });

  it('shows a blank line, and keeps nothing of it', () => {
    const { events, report } = readAll('\r\n', '   \t\r\n');
    expect(events).toEqual([
      { kind: 'line', text: '' },
      { kind: 'line', text: '   \t' },
    ]);
    expect(report.otherLines).toEqual([]);
  });

  it('reads a last line with no newline at end()', () => {
    const reader = createClaudeTurnReader();
    expect(reader.push(INIT + RESULT_OK.trimEnd())).toMatchObject([{ kind: 'init' }]);
    const { events, report } = reader.end();
    expect(events).toEqual([]);
    expect(report.result?.costUsd).toBe(0.0412);

    const trailing = createClaudeTurnReader();
    expect(trailing.push('Segmentation fault')).toEqual([]);
    expect(trailing.end()).toMatchObject({
      events: [{ kind: 'line', text: 'Segmentation fault' }],
      report: { otherLines: ['Segmentation fault'] },
    });
  });

  it("takes the result's fields", () => {
    const status = (value: unknown) =>
      readAll(resultLine({ is_error: true, result: undefined, api_error_status: value })).report
        .result;
    expect(status(529)?.apiErrorStatus).toBe(529);
    expect(status(null)).not.toHaveProperty('apiErrorStatus');
    expect(status('overloaded\x1b[0m\nmore')?.apiErrorStatus).toBe('overloaded');

    const denied = readAll(
      resultLine({
        permission_denials: [
          { tool_name: 'mcp__a__b', tool_use_id: 'toolu_1', tool_input: {} },
          { tool_name: 'mcp__a__b', tool_use_id: 'toolu_2', tool_input: {} },
          { tool_name: 'Read', tool_use_id: 'toolu_3', tool_input: { file_path: 'x' } },
          { tool_use_id: 'toolu_4' },
          'Grep',
        ],
      }),
    ).report.result;
    expect(denied?.deniedTools).toEqual(['mcp__a__b', 'Read']);

    const bare = readAll(jsonLine({ type: 'result', subtype: 'success' })).report.result;
    expect(bare).toEqual({
      subtype: 'success',
      isError: false,
      deniedTools: [],
      raw: { type: 'result', subtype: 'success' },
    });
    expect(readAll(jsonLine({ type: 'result' })).report.result?.subtype).toBe('no subtype');
    const nonsense = readAll(
      jsonLine({ type: 'result', subtype: 'success', total_cost_usd: '1', num_turns: -1 }),
    ).report.result;
    expect(nonsense).not.toHaveProperty('costUsd');
    expect(nonsense).not.toHaveProperty('turns');
  });

  it('reads the auth failure 2.1.330 printed', () => {
    expect(readAll(RESULT_AUTH).report.result).toMatchObject({
      isError: true,
      subtype: 'success',
      text: 'Not logged in · Please run /login',
      costUsd: 0,
      turns: 1,
    });
  });

  it('reads a turn that hit its cap, which has no result text', () => {
    const { result } = readAll(RESULT_MAX_TURNS).report;
    expect(result).toMatchObject({ subtype: 'error_max_turns', isError: true, turns: 6 });
    expect(result).not.toHaveProperty('text');
  });

  it('notices a usage limit', () => {
    const reader = createClaudeTurnReader();
    reader.push(INIT);
    expect(reader.limitNotice).toBe(false);
    expect(reader.push(ASSISTANT_RATE_LIMIT)).toEqual([]);
    expect(reader.limitNotice).toBe(true);
    expect(reader.end().report.limitNotice).toBe(true);

    const fromResult = readAll(
      resultLine({ is_error: true, result: "You've hit your limit · resets 3pm (Europe/Madrid)" }),
    );
    expect(fromResult.report.limitNotice).toBe(true);
    const prose = readAll(resultLine({ result: "if you've hit your rate limit, wait." }));
    expect(prose.report.limitNotice).toBe(false);
    const otherError = readAll(jsonLine({ type: 'assistant', error: 'authentication_failed' }));
    expect(otherError.report.limitNotice).toBe(false);
  });

  it('notices a usage limit printed outside its JSON, as a screen would have shown it', () => {
    // The pane marks such a line as the CLI's, so the screen no longer has it at a line's start.
    const reader = createClaudeTurnReader();
    reader.push(INIT);
    reader.push("\x1b[31mYou've hit your limit · resets 3pm (Europe/Madrid)\x1b[0m\r\n");
    expect(reader.limitNotice).toBe(true);
    expect(reader.end().report.limitNotice).toBe(true);
    expect(readAll("if you've hit your rate limit, wait.\n").report.limitNotice).toBe(false);
  });

  it('notices a rejected rate_limit_event', () => {
    const reader = createClaudeTurnReader();
    reader.push(RATE_LIMIT_REJECTED);
    expect(reader.limitNotice).toBe(true);
    for (const status of ['allowed', 'allowed_warning']) {
      const event = jsonLine({ type: 'rate_limit_event', rate_limit_info: { status } });
      expect(readAll(event).report.limitNotice).toBe(false);
    }
  });

  it('caps what it keeps', () => {
    const many = Array.from({ length: 250 }, (_, index) => `line ${index}\n`);
    const { report } = readAll(...many);
    expect(MAX_OTHER_LINES).toBe(200);
    expect(report.otherLines).toHaveLength(200);
    expect(report.otherLines[0]).toBe('line 50');
    expect(report.otherLines.at(-1)).toBe('line 249');

    const long = readAll(`${'w'.repeat(5000)}\n`);
    expect(MAX_LINE_CHARS).toBe(2000);
    expect(long.report.otherLines).toEqual(['w'.repeat(2000)]);
    expect(long.events).toEqual([{ kind: 'line', text: 'w'.repeat(5000) }]);
  });

  it('ignores other events', () => {
    const { events, report } = readAll(
      jsonLine({ type: 'user', message: { role: 'user', content: [] } }),
      jsonLine({ type: 'stream_event', event: { type: 'content_block_delta' } }),
      jsonLine({ type: 'system', subtype: 'status', status: 'compacting' }),
      jsonLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      jsonLine({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 7 }] } }),
    );
    expect(events).toEqual([]);
    expect(report).toEqual({ otherLines: [], limitNotice: false });
  });

  it('reads each tool call of one assistant event', () => {
    const { events } = readAll(
      jsonLine({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading two files.' },
            { type: 'tool_use', id: 't1', name: 'Read', input: {} },
            { type: 'tool_use', id: 't2', name: 'Grep', input: {} },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: 'tool', name: 'Read' },
      { kind: 'tool', name: 'Grep' },
    ]);
  });

  it('keeps the latest init and result', () => {
    const second = jsonLine({ ...JSON.parse(INIT), model: 'claude-haiku-5-5', mcp_servers: [] });
    const { report } = readAll(INIT, RESULT_AUTH, second, RESULT_OK);
    expect(report.init?.model).toBe('claude-haiku-5-5');
    expect(report.init?.servers).toEqual([]);
    expect(report.result?.turns).toBe(7);
  });

  it('takes only the servers it can name', () => {
    const init = jsonLine({
      ...JSON.parse(INIT),
      model: 42,
      mcp_servers: [
        { name: 'consola', status: 'connected' },
        { name: 'grafana', status: 'needs-auth' },
        { name: 'nameless' },
        { status: 'failed' },
        'srvb',
      ],
    });
    const { report } = readAll(init);
    expect(report.init).not.toHaveProperty('model');
    expect(report.init?.servers).toEqual([
      { name: 'consola', status: 'connected' },
      { name: 'grafana', status: 'needs-auth' },
    ]);
  });

  it('shapes the model and each server’s name and status, which reach the record and the step’s error', () => {
    const init = jsonLine({
      ...JSON.parse(INIT),
      model: `\x1b[31mclaude-opus-5-5\x1b[0m\nsecond line`,
      mcp_servers: [
        { name: `gra\x07fana${'n'.repeat(300)}`, status: '\x1b]0;x\x07needs-auth\r' },
        { name: '\x1b[2K', status: 'connected' },
        { name: 'consola', status: '\x07' },
      ],
    });
    const { report } = readAll(init);
    expect(report.init?.model).toBe('claude-opus-5-5');
    // A name or status with nothing left names nothing: that server is dropped.
    expect(report.init?.servers).toEqual([
      { name: `grafana${'n'.repeat(193)}…`, status: 'needs-auth' },
    ]);
    const blank = readAll(jsonLine({ ...JSON.parse(INIT), model: '\x1b[0m ' })).report;
    expect(blank.init).not.toHaveProperty('model');
  });

  it('reads a line a typed key was echoed in front of', () => {
    const echoed = readAll(`abc${INIT}`);
    expect(echoed.events).toMatchObject([{ kind: 'line', text: 'abc' }, { kind: 'init' }]);
    expect(echoed.report.otherLines).toEqual(['abc']);
    expect(echoed.report.init?.model).toBe('claude-opus-5-5');

    for (const key of ['^[[A', '^C', '^[[5~', '^[OA', '^[', '^?', '^C^C']) {
      const { events, report } = readAll(`${key}${RESULT_OK.replace('\n', '\r\n')}`);
      expect(lines(events), key).toEqual([]);
      expect(report.otherLines, key).toEqual([]);
      expect(report.result?.turns, key).toBe(7);
    }

    const atExit = readAll('^[[A\x1b[?25h\r\n');
    expect(atExit.report.otherLines).toEqual([]);
    for (const event of [...echoed.events, ...atExit.events]) {
      if (event.kind === 'line') expect(event.text).not.toContain('{"');
    }
  });

  it('reads a line whose echoed key carries a brace', () => {
    const { events, report } = readAll(`{${RESULT_OK}`);
    expect(lines(events)).toEqual([{ kind: 'line', text: '{' }]);
    expect(report.result?.turns).toBe(7);
  });

  it('a JSON line that only looks broken stays a line', () => {
    expect(MAX_JSON_RETRIES).toBe(8);
    const { events, report } = readAll('{"a":1} {"b":2}\n');
    expect(events).toEqual([{ kind: 'line', text: '{"a":1} {"b":2}' }]);
    expect(report.otherLines).toEqual(['{"a":1} {"b":2}']);

    // The JSON starts at the (n + 1)th brace: n tries reach it.
    const braces = `${'{'.repeat(MAX_JSON_RETRIES + 1)}${INIT}`;
    const tooMany = readAll(braces);
    expect(tooMany.events).toEqual([{ kind: 'line', text: braces.trimEnd() }]);
    const enough = readAll(`${'{'.repeat(MAX_JSON_RETRIES)}${INIT}`);
    expect(enough.events.map((event) => event.kind)).toEqual(['line', 'init']);
  });

  it("shapes the CLI's text", () => {
    const whole = 'Looked at \x1b[31mcatalog.ts\x1b[0m\x07\nsecond line\nthird';
    const { result } = readAll(resultLine({ result: whole })).report;
    expect(result?.text).toBe('Looked at catalog.ts');
    expect(result?.raw).toMatchObject({ result: whole });

    const long = readAll(resultLine({ result: 'r'.repeat(1000) })).report.result;
    expect(long?.text).toBe(`${'r'.repeat(300)}…`);

    const blank = readAll(resultLine({ result: ' \x1b[0m\n ' })).report.result;
    expect(blank).not.toHaveProperty('text');

    const denied = readAll(
      resultLine({ permission_denials: [{ tool_name: `x\x1b[2J${'n'.repeat(300)}` }] }),
    ).report.result;
    expect(denied?.deniedTools).toEqual([`x${'n'.repeat(199)}…`]);

    const warning = readAll('\x1b[33mWarning:\x1b[0m\tslow\x07\r\n');
    expect(warning.events).toEqual([{ kind: 'line', text: '\x1b[33mWarning:\x1b[0m\tslow\x07' }]);
    expect(warning.report.otherLines).toEqual(['Warning: slow']);
  });

  it('caps the partial line', () => {
    expect(MAX_PENDING_CHARS).toBe(8 * 1024 * 1024);
    const reader = createClaudeTurnReader();
    const held = reader.push('x'.repeat(MAX_PENDING_CHARS));
    expect(held).toEqual([]);
    const flushed = reader.push('x');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ kind: 'line' });
    expect(reader.push(INIT)).toMatchObject([{ kind: 'init' }]);
    expect(reader.end().report.otherLines).toEqual(['x'.repeat(2000)]);

    const once = createClaudeTurnReader();
    const events = once.push('x'.repeat(MAX_PENDING_CHARS + 1));
    expect(events).toHaveLength(1);
    expect(events[0].kind === 'line' && events[0].text.length).toBe(MAX_PENDING_CHARS + 1);
    expect(once.push(INIT)).toMatchObject([{ kind: 'init' }]);
  });
});
