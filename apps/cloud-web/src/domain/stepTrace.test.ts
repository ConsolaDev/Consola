import { describe, expect, it } from 'vitest';
import type { StepSummary } from './runs';
import {
  agentFile,
  attemptsLine,
  bytesInWords,
  cleanOutput,
  commandFailed,
  commandResult,
  earlierCosts,
  failureIsExit,
  failureWords,
  lastLine,
  limitWords,
  notRunReason,
  opensItself,
  outputTypeWords,
  printedWords,
  rowFacts,
  skippedCondition,
  stepCounts,
  stepOutcome,
  stepSummary,
  stepTone,
  stepWorkedFor,
  turnLine,
} from './stepTrace';

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A step as the cell answers one, with what a test changes. */
function aStep(overrides: Partial<StepSummary> = {}): StepSummary {
  return {
    id: 'review',
    kind: 'agent',
    status: 'completed',
    attempt: 1,
    agent: 'reviewer',
    model: 'claude-opus',
    startedAt: ago(90_000),
    finishedAt: ago(30_000),
    costUsd: null,
    error: null,
    skipped: null,
    outputs: null,
    artifacts: [],
    turn: null,
    command: null,
    previous: [],
    reminded: false,
    output: null,
    definition: null,
    ...overrides,
  };
}

const command = (overrides: Partial<NonNullable<StepSummary['command']>> = {}) => ({
  exitCode: 0,
  signal: null,
  stdoutBytes: 4300,
  stderrBytes: 0,
  truncated: false,
  ...overrides,
});

const run = { status: 'running' as const, phase: 'active' as const, steps: [] };

describe('stepTone', () => {
  it('reads each status', () => {
    expect(stepTone('completed', false)).toBe('passed');
    expect(stepTone('failed', true)).toBe('failed');
    expect(stepTone('running', false)).toBe('running');
    expect(stepTone('queued', false)).toBe('waiting');
    expect(stepTone('skipped', true)).toBe('skipped');
    expect(stepTone('reported', true)).toBe('reported');
  });

  it('reads a step still to come as not run once the run is over, and an unknown status the same', () => {
    expect(stepTone('pending', false)).toBe('pending');
    expect(stepTone('pending', true)).toBe('not-run');
    expect(stepTone('queued', true)).toBe('not-run');
    expect(stepTone('paused' as StepSummary['status'], true)).toBe('not-run');
  });
});

describe('opensItself', () => {
  it('opens where the run broke or stands now', () => {
    expect(opensItself({ status: 'failed' })).toBe(true);
    expect(opensItself({ status: 'running' })).toBe(true);
    expect(opensItself({ status: 'queued' })).toBe(true);
    expect(opensItself({ status: 'completed' })).toBe(false);
    expect(opensItself({ status: 'skipped' })).toBe(false);
  });
});

describe('stepWorkedFor and stepOutcome', () => {
  it('measures to now while it runs, and not at all for an ended step with no finish', () => {
    expect(stepWorkedFor(aStep({ status: 'running', finishedAt: null }), NOW)).toBe(90_000);
    expect(stepWorkedFor(aStep({ status: 'failed', finishedAt: null }), NOW)).toBeNull();
    expect(stepWorkedFor(aStep(), NOW)).toBe(60_000);
  });

  it('says the outcome with how long it took', () => {
    expect(stepOutcome(aStep(), 'passed', 60_000)).toBe('Completed in 1m 0s');
    expect(stepOutcome(aStep({ status: 'queued' }), 'waiting', null)).toBe('Queued');
    expect(stepOutcome(aStep(), 'not-run', null)).toBe('Did not run');
  });
});

describe('rowFacts', () => {
  it('is an agent’s duration, turns and cost', () => {
    const step = aStep({ turn: { turns: 3, maxTurns: 30, deniedTools: [] }, costUsd: 0.12 });
    expect(rowFacts(step, NOW)).toBe('1m 0s · 3 turns · $0.12');
  });

  it('is a command’s duration and exit', () => {
    expect(rowFacts(aStep({ kind: 'run', command: command() }), NOW)).toBe('1m 0s · exit 0');
    expect(rowFacts(aStep({ kind: 'run', command: command({ signal: 'SIGTERM' }) }), NOW)).toBe(
      '1m 0s · killed by SIGTERM',
    );
  });

  it('says nothing it was not told', () => {
    expect(rowFacts(aStep({ startedAt: null, finishedAt: null }), NOW)).toBeNull();
  });
});

describe('attemptsLine', () => {
  it('is nothing for a first attempt', () => {
    expect(attemptsLine(aStep())).toBeNull();
  });

  it('says the attempt and how each earlier one ended, in order', () => {
    const earlier = (attempt: number, status: StepSummary['status']) => ({
      attempt,
      status,
      error: null,
      finishedAt: null,
      costUsd: null,
      turns: null,
    });
    expect(
      attemptsLine(aStep({ attempt: 3, previous: [earlier(2, 'not-run'), earlier(1, 'failed')] })),
    ).toBe('Attempt 3 · earlier: 1 failed, 2 did not run');
  });

  it('says a reminder', () => {
    expect(attemptsLine(aStep({ reminded: true }))).toBe('Reminded once');
    expect(attemptsLine(aStep({ attempt: 2, reminded: true }))).toBe('Attempt 2 · reminded once');
  });
});

describe('turnLine and earlierCosts', () => {
  it('says the turns against the cap, and the cost', () => {
    const step = aStep({ turn: { turns: 7, maxTurns: 30, deniedTools: [] }, costUsd: 0.04 });
    expect(turnLine(step)).toBe('7 turns of at most 30 · $0.04');
    expect(turnLine(aStep({ turn: { turns: null, maxTurns: 30, deniedTools: [] } }))).toBe(
      'At most 30 turns',
    );
  });

  it('leaves the cap out after a reminder, and says nothing of a command', () => {
    expect(
      turnLine(aStep({ reminded: true, turn: { turns: 9, maxTurns: 8, deniedTools: [] } })),
    ).toBe('9 turns');
    expect(turnLine(aStep({ kind: 'run' }))).toBeNull();
  });

  it('says what each earlier attempt cost', () => {
    const previous = [
      {
        attempt: 2,
        status: 'failed' as const,
        error: null,
        finishedAt: null,
        costUsd: null,
        turns: null,
      },
      {
        attempt: 1,
        status: 'failed' as const,
        error: null,
        finishedAt: null,
        costUsd: 0.01,
        turns: 6,
      },
    ];
    expect(earlierCosts(aStep({ previous }))).toBe(
      'Earlier attempts: 1 $0.01 in 6 turns, 2 no cost reported',
    );
    expect(earlierCosts(aStep())).toBeNull();
  });
});

describe('a command', () => {
  it('says how it ended', () => {
    expect(commandResult(aStep({ command: command({ exitCode: 1 }) }))).toBe('Exit code 1');
    expect(commandResult(aStep({ command: command({ signal: 'SIGKILL' }) }))).toBe(
      'Stopped by SIGKILL',
    );
    expect(commandResult(aStep({ status: 'running', command: null }))).toBe('Still running…');
    expect(commandResult(aStep({ command: null }))).toBeNull();
    expect(commandFailed(command({ exitCode: 1 }))).toBe(true);
    expect(commandFailed(command())).toBe(false);
  });

  it('says what it printed', () => {
    expect(printedWords(command({ stderrBytes: 120 }))).toBe('4.2 KB on stdout, 120 B on stderr');
    expect(printedWords(command({ stdoutBytes: 0 }))).toBe('nothing');
    expect(printedWords(command({ stdoutBytes: null, stderrBytes: null }))).toBeNull();
  });
});

describe('bytesInWords', () => {
  it('says a size as the desktop does', () => {
    expect(bytesInWords(0)).toBe('0 B');
    expect(bytesInWords(512)).toBe('512 B');
    expect(bytesInWords(2048)).toBe('2.0 KB');
    expect(bytesInWords(1.3 * 1024 * 1024)).toBe('1.3 MB');
    expect(bytesInWords(-1)).toBe('');
  });
});

describe('stepSummary', () => {
  it('is the error, word for word, for a failure', () => {
    expect(stepSummary(aStep({ status: 'failed', error: 'exit 1: boom' }), run)).toBe(
      'exit 1: boom',
    );
    expect(stepSummary(aStep({ status: 'failed' }), run)).toBe('It failed without saying why.');
  });

  it('says why it was skipped', () => {
    expect(stepSummary(aStep({ status: 'skipped', skipped: 'if: steps.a.ok is false' }), run)).toBe(
      'if: steps.a.ok was false',
    );
    expect(stepSummary(aStep({ status: 'skipped', skipped: 'no item' }), run)).toBe('no item');
  });

  it('says what a completed step set, wrote or printed', () => {
    expect(
      stepSummary(
        aStep({
          outputs: { verdict: 'approve', findings: 3 },
          artifacts: [{ name: 'review.md', bytes: 2048 }],
        }),
        run,
      ),
    ).toBe('Set verdict = approve, findings = 3 · wrote review.md (2.0 KB)');
    expect(stepSummary(aStep({ kind: 'run', command: command() }), run)).toBe(
      'Printed 4.2 KB on stdout',
    );
    expect(stepSummary(aStep(), run)).toBeNull();
  });

  it('shows a running command’s last line, and an agent at work', () => {
    const running = { status: 'running' as const, finishedAt: null };
    expect(
      stepSummary(
        aStep({
          ...running,
          kind: 'run',
          output: {
            stdout: 'building\n\u001b[32mcompiled 12 modules\u001b[0m\n\n',
            stderr: '',
            truncated: false,
          },
        }),
        run,
      ),
    ).toBe('compiled 12 modules');
    expect(
      stepSummary(aStep({ ...running, turn: { turns: 2, maxTurns: null, deniedTools: [] } }), run),
    ).toBe('Working, 2 turns so far');
  });

  it('says why a step the run never reached did not run', () => {
    const over = {
      status: 'failed' as const,
      phase: 'failed' as const,
      steps: [{ id: 'build', status: 'failed' as const }],
    };
    expect(stepSummary(aStep({ status: 'pending' }), over)).toBe(
      'The run stopped at build before reaching it.',
    );
  });
});

describe('notRunReason', () => {
  it('says how the run ended', () => {
    expect(notRunReason('rejected', [])).toBe('The run was turned down before it started.');
    expect(notRunReason('cancelled', [])).toBe('The run was cancelled before reaching it.');
    expect(notRunReason('expired', [])).toBe('The run failed before reaching it.');
    expect(notRunReason('completed', [])).toBe('The run ended before reaching it.');
  });
});

describe('failureWords', () => {
  it('says a command’s exit, and quotes its last stderr line', () => {
    expect(failureWords('exit 2: npm ERR! missing script')).toEqual({
      text: 'Its command exited with code 2. The last line it wrote to stderr:',
      quote: 'npm ERR! missing script',
    });
    expect(failureWords('killed by SIGTERM')).toEqual({
      text: 'Its command was killed by SIGTERM.',
      quote: null,
    });
    expect(failureIsExit('exit 2')).toBe(true);
    expect(failureIsExit('the agent gave no verdict')).toBe(false);
  });

  it('says a timeout, and any other error as a sentence', () => {
    expect(failureWords('timed out after 10m').text).toBe(
      'Its command ran past its 10m timeout and was stopped.',
    );
    expect(failureWords('the agent gave no verdict').text).toBe('The agent gave no verdict.');
    expect(failureWords(null).text).toBe('It failed without saying why.');
  });
});

describe('stepCounts', () => {
  it('counts how the steps went', () => {
    expect(
      stepCounts(
        [
          { status: 'completed' },
          { status: 'completed' },
          { status: 'failed' },
          { status: 'pending' },
        ],
        true,
      ),
    ).toBe('4 steps · 2 completed · 1 failed · 1 did not run');
    expect(stepCounts([{ status: 'running' }], false)).toBe('1 step · 1 running');
  });
});

describe('words for a definition', () => {
  it('says a declared output’s type', () => {
    expect(outputTypeWords('string')).toBe('text');
    expect(outputTypeWords('number')).toBe('a number');
    expect(outputTypeWords('boolean')).toBe('true or false');
    expect(outputTypeWords('one of: approve, request-changes')).toBe(
      'one of approve, request-changes',
    );
    expect(outputTypeWords('json')).toBe('json');
  });

  it('says a time limit', () => {
    expect(limitWords(45_000)).toBe('45s');
    expect(limitWords(600_000)).toBe('10m');
    expect(limitWords(90_000)).toBe('1m 30s');
    expect(limitWords(5_400_000)).toBe('1h 30m');
  });

  it('names an agent’s file', () => {
    expect(agentFile('reviewer')).toBe('agents/reviewer.md');
    expect(agentFile('agents/reviewer.md')).toBe('agents/reviewer.md');
  });

  it('reads the condition a step was skipped on', () => {
    expect(skippedCondition('if: steps.a.ok is false')).toBe('steps.a.ok');
    expect(skippedCondition('no item')).toBeNull();
    expect(skippedCondition(null)).toBeNull();
  });
});

describe('cleanOutput', () => {
  it('keeps text, newlines and tabs', () => {
    expect(cleanOutput('a\tb\nc\n')).toBe('a\tb\nc\n');
  });

  it('drops colours, cursor moves and erasures', () => {
    expect(cleanOutput('\u001b[1;32mok\u001b[0m \u001b[2K\u001b[1A\u001b[?25ldone')).toBe(
      'ok done',
    );
  });

  it('drops a window title and keeps a link’s text', () => {
    expect(
      cleanOutput('\u001b]0;evil title\u0007\u001b]8;;https://x.test\u001b\\see\u001b]8;;\u001b\\'),
    ).toBe('see');
  });

  it('drops 8-bit sequences, other escapes and a sequence cut off at the end', () => {
    expect(cleanOutput('\u009b31mred\u009b0m \u001b(Bplain \u001b7x\u001b[38;5')).toBe(
      'red plain x',
    );
  });

  it('drops control characters but a newline and a tab', () => {
    expect(cleanOutput('a\u0000b\u0007c\u007fd\u0085e')).toBe('abcde');
  });

  it('drops characters that reorder text', () => {
    expect(cleanOutput('safe‮txt.exe⁦x⁩')).toBe('safetxt.exex');
  });

  it('redraws a line on a carriage return, keeps CRLF lines, and takes back a backspace', () => {
    expect(cleanOutput('10%\r50%\r100%\nnext')).toBe('100%\nnext');
    expect(cleanOutput('one\r\ntwo\r\n')).toBe('one\ntwo\n');
    expect(cleanOutput('spin |\b/\b-\bdone')).toBe('spin done');
  });

  it('gives the last line that says something', () => {
    expect(lastLine('a\nb\n\n  \n')).toBe('b');
    expect(lastLine('\u001b[0m\n')).toBeNull();
    expect(lastLine('x'.repeat(300))).toHaveLength(160);
  });
});
