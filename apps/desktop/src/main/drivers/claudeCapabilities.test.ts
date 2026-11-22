import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  mapInitializeResponse,
  requestControl,
  requestInitializeHandshake,
  requestUsage,
} from './claudeCapabilities';

/**
 * The handshake is the one part of this feature that talks to another process,
 * so it is exercised against real spawned children rather than a mocked
 * `child_process`. Each fake CLI below is a tiny Node script standing in for a
 * `claude` that behaves badly in a specific way — the failures that matter are
 * a hung child, a build too old to answer, and output that no longer parses.
 */

const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-capabilities-'));

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

/**
 * Run the handshake against a fake CLI.
 *
 * `requestInitializeHandshake` spawns a binary with a fixed argument list, so
 * the fake is wrapped in a small executable shim that already knows which
 * script to run.
 */
function runAgainst(scriptBody: string, timeoutMs = 5000): Promise<unknown> {
  return requestInitializeHandshake(fakeCli(scriptBody), scriptDir, process.env, timeoutMs);
}

/** An executable that runs `scriptBody` under Node, passing its arguments through. */
function fakeCli(scriptBody: string): string {
  const file = path.join(scriptDir, `cli-${Math.abs(hash(scriptBody))}.cjs`);
  fs.writeFileSync(file, scriptBody, 'utf8');
  const shim = path.join(scriptDir, `shim-${Math.abs(hash(scriptBody))}.sh`);
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`, 'utf8');
  fs.chmodSync(shim, 0o755);
  return shim;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return result;
}

const ANSWER = {
  commands: [{ name: 'commit', description: 'Create a git commit', argumentHint: '' }],
  agents: [{ name: 'Explore', description: 'Read-only search agent' }],
  models: [
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Efficient for routine tasks',
    },
  ],
  available_output_styles: ['default', 'Concise'],
  account: { email: 'someone@example.com', subscriptionType: 'Claude Max' },
};

describe('requestInitializeHandshake', () => {
  it('reads the answer even when it arrives split across chunks', async () => {
    // The real CLI's response runs to tens of kilobytes and never lands in
    // one read. Splitting mid-line is the case that a naive
    // split-each-chunk parser gets wrong.
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
    });
    const result = await runAgainst(`
            const line = ${JSON.stringify(line)};
            process.stdout.write(line.slice(0, 20));
            setTimeout(() => process.stdout.write(line.slice(20, 60)), 10);
            setTimeout(() => process.stdout.write(line.slice(60) + "\\n"), 20);
            setTimeout(() => {}, 5000);
        `);

    expect(mapInitializeResponse(result).commands).toHaveLength(1);
  });

  it('ignores hook chatter and unparseable lines before the answer', async () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
    });
    const result = await runAgainst(`
            process.stdout.write('not json at all\\n');
            process.stdout.write(JSON.stringify({type:'system',subtype:'hook_started'}) + "\\n");
            process.stdout.write(${JSON.stringify(line)} + "\\n");
            setTimeout(() => {}, 5000);
        `);

    expect(mapInitializeResponse(result).agents[0].name).toBe('Explore');
  });

  it('rejects when the CLI exits without answering, quoting its stderr', async () => {
    // What an older build does: it does not recognise the flags and dies.
    await expect(
      runAgainst(`
                process.stderr.write('unknown option --input-format');
                process.exit(2);
            `),
    ).rejects.toThrow(/unknown option --input-format/);
  });

  it('rejects rather than hanging when no answer ever comes', async () => {
    await expect(runAgainst(`setTimeout(() => {}, 60000);`, 300)).rejects.toThrow(/within 300ms/);
  });

  it('rejects when the CLI reports an error for the request', async () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'consola-initialize',
        error: 'initialize is not supported',
      },
    });
    await expect(
      runAgainst(`
                process.stdout.write(${JSON.stringify(line)} + "\\n");
                setTimeout(() => {}, 5000);
            `),
    ).rejects.toThrow(/initialize is not supported/);
  });

  it('rejects when the binary does not exist instead of crashing the process', async () => {
    await expect(
      requestInitializeHandshake(
        path.join(scriptDir, 'definitely-not-here'),
        scriptDir,
        process.env,
        2000,
      ),
    ).rejects.toThrow();
  });

  it('leaves no child running once it has its answer', async () => {
    // A CLI that would sit forever if nobody killed it.
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'consola-initialize', response: ANSWER },
    });
    const marker = path.join(scriptDir, 'still-alive');
    await runAgainst(`
            process.stdout.write(${JSON.stringify(line)} + "\\n");
            setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 400);
            setTimeout(() => {}, 5000);
        `);
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(fs.existsSync(marker)).toBe(false);
  });
});

/**
 * A CLI that answers every control request it reads, `initialize` a moment
 * late, and reports back what it saw when the later requests arrived: whether
 * the earlier answer had gone out, whether stdin had already ended, its argv.
 */
const SEQUENCE_CLI = `
  const lines = require('readline').createInterface({ input: process.stdin });
  let answeredFirst = false;
  let stdinEnded = false;
  lines.on('close', () => { stdinEnded = true; });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const reply = (subtype, body) => process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype, request_id: message.request_id, ...body },
    }) + '\\n');
    if (message.request.subtype === 'initialize') {
      setTimeout(() => { answeredFirst = true; reply('success', { response: { commands: [] } }); }, 50);
    } else if (message.request.subtype === 'refuse') {
      reply('error', { error: 'get_usage is not supported' });
    } else {
      reply('success', { response: {
        request: message.request, answeredFirst, stdinEnded, argv: process.argv.slice(2),
      } });
    }
  });
  setTimeout(() => {}, 5000);
`;

describe('requestControl', () => {
  it('asks the next question only once the last is answered, keeping stdin open until then', async () => {
    const [initialize, second] = await requestControl(
      fakeCli(SEQUENCE_CLI),
      scriptDir,
      process.env,
      [
        { requestId: 'a', request: { subtype: 'initialize' } },
        { requestId: 'b', request: { subtype: 'get_usage', skip_behaviors: true } },
      ],
    );

    expect(initialize).toEqual({ commands: [] });
    expect(second).toMatchObject({
      request: { subtype: 'get_usage', skip_behaviors: true },
      answeredFirst: true,
      stdinEnded: false,
    });
  });

  it('adds its extra arguments after the protocol flags', async () => {
    const [, second] = await requestControl(
      fakeCli(SEQUENCE_CLI),
      scriptDir,
      process.env,
      [
        { requestId: 'a', request: { subtype: 'initialize' } },
        { requestId: 'b', request: { subtype: 'anything' } },
      ],
      { extraArgs: ['--settings', '{"disableAllHooks":true}'] },
    );

    expect((second as { argv: string[] }).argv.slice(-3)).toEqual([
      '--no-session-persistence',
      '--settings',
      '{"disableAllHooks":true}',
    ]);
  });

  it('rejects when a later request is refused, rather than returning the first answer alone', async () => {
    await expect(
      requestControl(fakeCli(SEQUENCE_CLI), scriptDir, process.env, [
        { requestId: 'a', request: { subtype: 'initialize' } },
        { requestId: 'b', request: { subtype: 'refuse' } },
      ]),
    ).rejects.toThrow(/get_usage is not supported/);
  });
});

/**
 * A CLI that answers `initialize`, then each `poll` with how many it has
 * read so far and whether its stdin had ended by then.
 */
const POLL_CLI = `
  const lines = require('readline').createInterface({ input: process.stdin });
  let polls = 0;
  let stdinEnded = false;
  lines.on('close', () => { stdinEnded = true; });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const response = message.request.subtype === 'initialize'
      ? { commands: [] }
      : { polls: ++polls, stdinEnded };
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id, response },
    }) + '\\n');
  });
  setTimeout(() => {}, 5000);
`;

describe('requestControl, repeating its last request', () => {
  const POLLING = [
    { requestId: 'a', request: { subtype: 'initialize' } },
    { requestId: 'b', request: { subtype: 'poll' } },
  ];

  it('asks the last request again until its answer holds, with stdin still open', async () => {
    const [initialize, last] = await requestControl(
      fakeCli(POLL_CLI),
      scriptDir,
      process.env,
      POLLING,
      {
        repeat: {
          until: (answer) => (answer as { polls: number }).polls >= 3,
          everyMs: 20,
          forMs: 3000,
        },
      },
    );

    expect(initialize).toEqual({ commands: [] });
    expect(last).toEqual({ polls: 3, stdinEnded: false });
  });

  it('answers with the last answer once its time is up', async () => {
    const [, last] = await requestControl(fakeCli(POLL_CLI), scriptDir, process.env, POLLING, {
      repeat: { until: () => false, everyMs: 20, forMs: 250 },
    });

    expect((last as { polls: number }).polls).toBeGreaterThan(1);
  });

  it('asks once when the first answer already holds', async () => {
    const [, last] = await requestControl(fakeCli(POLL_CLI), scriptDir, process.env, POLLING, {
      repeat: { until: () => true, everyMs: 20, forMs: 3000 },
    });

    expect(last).toEqual({ polls: 1, stdinEnded: false });
  });

  it('rejects with what a check that throws said, rather than throwing in the stream', async () => {
    await expect(
      requestControl(fakeCli(POLL_CLI), scriptDir, process.env, POLLING, {
        repeat: {
          until: () => {
            throw new Error('an answer the caller cannot read');
          },
          everyMs: 20,
          forMs: 3000,
        },
      }),
    ).rejects.toThrow('an answer the caller cannot read');
  });

  it('without repeat, asks each request once, as before', async () => {
    const [, last] = await requestControl(fakeCli(POLL_CLI), scriptDir, process.env, POLLING);

    expect(last).toMatchObject({ polls: 1 });
  });

  it('still gives up at its deadline while repeating', async () => {
    await expect(
      requestControl(fakeCli(POLL_CLI), scriptDir, process.env, POLLING, {
        timeoutMs: 300,
        repeat: { until: () => false, everyMs: 20, forMs: 3000 },
      }),
    ).rejects.toThrow(/within 300ms/);
  });
});

describe('requestUsage', () => {
  it('asks for usage without running hooks or scanning transcripts, after initialising', async () => {
    const usage = await requestUsage(fakeCli(SEQUENCE_CLI), scriptDir, process.env);

    expect(usage).toMatchObject({
      request: { subtype: 'get_usage', skip_behaviors: true },
      answeredFirst: true,
    });
    const { argv } = usage as { argv: string[] };
    expect(argv).toContain('--no-session-persistence');
    expect(argv.slice(argv.indexOf('--settings'), argv.indexOf('--settings') + 2)).toEqual([
      '--settings',
      '{"disableAllHooks":true}',
    ]);
  });

  it('gives up at its deadline', async () => {
    await expect(
      requestUsage(fakeCli('setTimeout(() => {}, 60000);'), scriptDir, process.env, 300),
    ).rejects.toThrow(/within 300ms/);
  });
});

describe('mapInitializeResponse', () => {
  it('maps a full answer', () => {
    const capabilities = mapInitializeResponse(ANSWER);

    expect(capabilities.commands[0]).toEqual({
      name: 'commit',
      description: 'Create a git commit',
      argumentHint: undefined,
      aliases: undefined,
    });
    expect(capabilities.models[0].resolvedModel).toBe('claude-sonnet-5');
    expect(capabilities.outputStyles).toEqual(['default', 'Concise']);
    expect(capabilities.account).toMatchObject({
      signedIn: true,
      subscriptionType: 'Claude Max',
    });
  });

  it('reports a signed-out profile as signed out rather than dropping it', () => {
    const capabilities = mapInitializeResponse({
      ...ANSWER,
      account: { tokenSource: 'none', apiProvider: 'firstParty' },
    });

    expect(capabilities.account).toMatchObject({ signedIn: false });
  });

  it('tolerates a missing agent or model list', () => {
    const capabilities = mapInitializeResponse({ commands: [] });

    expect(capabilities.agents).toEqual([]);
    expect(capabilities.models).toEqual([]);
  });

  it('drops entries with no name rather than rendering a blank row', () => {
    const capabilities = mapInitializeResponse({
      commands: [{ description: 'nameless' }, { name: 'ok', description: '' }],
    });

    expect(capabilities.commands.map((command) => command.name)).toEqual(['ok']);
  });

  it('throws on a shape it does not recognise, rather than reporting no commands', () => {
    // The failure this guards: a future CLI renames the field, every
    // harness silently shows an empty menu, and nothing says why.
    expect(() => mapInitializeResponse({ slashCommands: [] })).toThrow(/command list/);
    expect(() => mapInitializeResponse('nope')).toThrow(/object/);
  });
});
