import { cutAt, oneLine, stripEscapes, withoutControls } from '../../shared/oneLine';
import { showsClaudeLimitNotice } from './claudeUsage';
import type { TurnEvent, TurnInit, TurnReader, TurnReport, TurnResult } from './HarnessDriver';

/**
 * Reading one reporting turn of Claude's, launched with
 * `--output-format stream-json --verbose`, as its PTY hands it over.
 *
 * A line is the text before a `\n`, its trailing `\r` removed. Terminal
 * escapes are removed before a line is parsed: in a PTY the CLI ends its run
 * with an `ESC[?25h` of its own. A key the person typed into the PTY is
 * echoed in front of the CLI's next line (node-pty opens it with ECHO and
 * ECHOCTL, and print mode never turns them off), an arrow as the printable
 * `^[[A`, so a line that does not parse whole is tried again from each later
 * `{`. The `result` line's first key is `duration_api_ms`, so nothing here
 * looks for `{"type"`.
 *
 * What is not JSON (a warning, a crash's stack) is handed over as printed for
 * the pane, which shows it inert and marked, and kept, cleaned, for the step's
 * error and `turn.json`. Pure: no I/O, no timers.
 */

/** Where Claude signs in to an MCP server, for the `init` check's words. */
export const CLAUDE_SIGN_IN_HINT = 'run `claude`, then /mcp';

/** The lines outside JSON a report keeps: the last ones. */
export const MAX_OTHER_LINES = 200;
/** The most of one kept line. */
export const MAX_LINE_CHARS = 2000;
/** The most of a line held while waiting for its newline; past it, what is held is a line. */
export const MAX_PENDING_CHARS = 8 * 1024 * 1024;
/** How many later `{` a line that does not parse whole is tried from. */
export const MAX_JSON_RETRIES = 8;

/** The most of a tool's name the record keeps. */
const MAX_TOOL_NAME_CHARS = 200;

/**
 * A control key as the PTY echoes it: `^[` and the rest of its sequence
 * (`^[[A`, `^[[5~`, `^[OA`, Alt with a key), or `^` and one of `@A-Z[\]^_?`
 * (`^C`, `^?`).
 */
const ECHOED_KEY = /\^\[(?:\[[0-?]*[ -/]*[@-~]|O[@-~]|[ -~]?)|\^[@A-Z\\\]^_?]/g;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object the CLI could have meant as an event: one with a string `type`. */
function asEvent(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) && typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** A line as `otherLines` keeps it: escapes and controls removed, cut short. */
function kept(line: string): string {
  return cutAt(withoutControls(line).trimEnd(), MAX_LINE_CHARS, '');
}

/** Whether a line holds anything once escapes, echoed keys, controls and spaces are gone. */
function saysSomething(line: string): boolean {
  return withoutControls(stripEscapes(line).replace(ECHOED_KEY, '')).trim() !== '';
}

/** The most of a model's, a server's name or a status the record keeps. */
const MAX_INIT_FIELD_CHARS = 200;

/**
 * The CLI's `init`, its words shaped with `oneLine`: the model reaches the
 * step's record and the run page, a server's name and status the step's
 * error. A server whose name or status has nothing left is dropped.
 */
function readInit(event: JsonObject): TurnInit {
  const servers: TurnInit['servers'] = [];
  if (Array.isArray(event.mcp_servers)) {
    for (const server of event.mcp_servers) {
      if (!isObject(server) || typeof server.name !== 'string' || typeof server.status !== 'string')
        continue;
      const name = oneLine(server.name, MAX_INIT_FIELD_CHARS);
      const status = oneLine(server.status, MAX_INIT_FIELD_CHARS);
      if (name && status) servers.push({ name, status });
    }
  }
  const model = typeof event.model === 'string' ? oneLine(event.model, MAX_INIT_FIELD_CHARS) : '';
  return {
    ...(model ? { model } : {}),
    servers,
    signInHint: CLAUDE_SIGN_IN_HINT,
    raw: event,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * A denial as the record names it: the tool, or for the Skill tool the
 * skill it was asked for, `Skill(<name>)` (`tool_input.skill`, canary row
 * 24), which is the rule a step's deny list writes.
 */
function deniedName(toolName: string, input: unknown): string {
  const tool = oneLine(toolName, MAX_TOOL_NAME_CHARS);
  if (tool !== 'Skill' || !isObject(input) || typeof input.skill !== 'string') return tool;
  const skill = oneLine(input.skill, MAX_TOOL_NAME_CHARS);
  return skill ? `Skill(${skill})` : tool;
}

function readResult(event: JsonObject): TurnResult {
  const denied: string[] = [];
  if (Array.isArray(event.permission_denials)) {
    for (const denial of event.permission_denials) {
      if (!isObject(denial) || typeof denial.tool_name !== 'string') continue;
      const name = deniedName(denial.tool_name, denial.tool_input);
      if (name && !denied.includes(name)) denied.push(name);
    }
  }
  const text = typeof event.result === 'string' ? oneLine(event.result) : '';
  const status =
    typeof event.api_error_status === 'number'
      ? event.api_error_status
      : typeof event.api_error_status === 'string'
        ? oneLine(event.api_error_status) || undefined
        : undefined;
  return {
    // A result without one is malformed; say so rather than invent `success`.
    subtype:
      typeof event.subtype === 'string' && event.subtype ? oneLine(event.subtype) : 'no subtype',
    isError: event.is_error === true,
    ...(isAmount(event.total_cost_usd) ? { costUsd: event.total_cost_usd } : {}),
    ...(isCount(event.num_turns) ? { turns: event.num_turns } : {}),
    ...(text ? { text } : {}),
    ...(status !== undefined ? { apiErrorStatus: status } : {}),
    deniedTools: denied,
    raw: event,
  };
}

export function createClaudeTurnReader(): TurnReader {
  let pending = '';
  let init: TurnInit | undefined;
  let result: TurnResult | undefined;
  let limitNotice = false;
  const otherLines: string[] = [];

  /**
   * A line outside JSON: handed to the pane as printed (which shows it inert
   * and marked as the CLI's), kept when it says anything. A usage limit in it
   * counts as one on screen would: the mark keeps it off a line's start.
   */
  const other = (shown: string, events: TurnEvent[]) => {
    events.push({ kind: 'line', text: shown });
    if (!saysSomething(shown)) return;
    const line = kept(shown);
    if (showsClaudeLimitNotice(line)) limitNotice = true;
    otherLines.push(line);
    if (otherLines.length > MAX_OTHER_LINES) otherLines.shift();
  };

  const read = (event: JsonObject, events: TurnEvent[]) => {
    switch (event.type) {
      case 'system':
        if (event.subtype !== 'init') return;
        init = readInit(event);
        events.push({ kind: 'init', init });
        return;
      case 'assistant': {
        if (event.error === 'rate_limit') limitNotice = true;
        const content = isObject(event.message) ? event.message.content : undefined;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (isObject(block) && block.type === 'tool_use' && typeof block.name === 'string')
            events.push({ kind: 'tool', name: block.name });
        }
        return;
      }
      case 'rate_limit_event':
        // A hint, as a notice on screen is: the reset still comes from the CLI.
        if (isObject(event.rate_limit_info) && event.rate_limit_info.status === 'rejected')
          limitNotice = true;
        return;
      case 'result':
        result = readResult(event);
        if (typeof event.result === 'string' && showsClaudeLimitNotice(event.result))
          limitNotice = true;
        return;
      default:
        return;
    }
  };

  const readLine = (raw: string, events: TurnEvent[]) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const text = stripEscapes(line).trim();
    const whole = asEvent(text);
    if (whole) return read(whole, events);
    // An echoed key in front of the CLI's line: try each later `{`.
    let from = 0;
    for (let tries = 0; tries < MAX_JSON_RETRIES; tries++) {
      from = text.indexOf('{', from + 1);
      if (from === -1) break;
      const event = asEvent(text.slice(from));
      if (!event) continue;
      const fragment = text.slice(0, from).trimEnd();
      if (saysSomething(fragment)) other(fragment, events);
      return read(event, events);
    }
    other(line, events);
  };

  return {
    push(chunk) {
      const events: TurnEvent[] = [];
      let start = 0;
      for (let end = chunk.indexOf('\n'); end !== -1; end = chunk.indexOf('\n', start)) {
        readLine(pending + chunk.slice(start, end), events);
        pending = '';
        start = end + 1;
      }
      pending += chunk.slice(start);
      if (pending.length > MAX_PENDING_CHARS) {
        readLine(pending, events);
        pending = '';
      }
      return events;
    },
    get limitNotice() {
      return limitNotice;
    },
    get resultSeen() {
      return result !== undefined;
    },
    end() {
      const events: TurnEvent[] = [];
      if (pending) readLine(pending, events);
      pending = '';
      const report: TurnReport = {
        ...(init ? { init } : {}),
        ...(result ? { result } : {}),
        otherLines: [...otherLines],
        limitNotice,
      };
      return { events, report };
    },
  };
}
