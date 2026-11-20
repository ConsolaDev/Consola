import { describe, expect, it } from 'vitest';
import type { OutputType } from '@consola/factory-spec';
import type { CommandResult } from '../ports';
import {
  OUTPUT_FILE_CAP_BYTES,
  describeFailure,
  layerCommandEnv,
  maskSecrets,
  parseOutputFile,
} from './commandIO';

const VERDICT: OutputType = { type: 'enum', values: ['approve', 'comment', 'request-changes'] };
const COUNT: OutputType = { type: 'integer' };
const NOTE: OutputType = { type: 'string', maxLength: 100 };
const TOKEN = 'gho_abc123';

const parse = (text: string, declared: Record<string, OutputType>, secrets: string[] = []) =>
  parseOutputFile(text, declared, secrets);

function failed(
  text: string,
  declared: Record<string, OutputType>,
  secrets: string[] = [],
): string {
  const parsed = parse(text, declared, secrets);
  if (parsed.ok) throw new Error(`expected a problem, got ${JSON.stringify(parsed.outputs)}`);
  return parsed.problem;
}

describe('maskSecrets', () => {
  it('replaces every occurrence of each secret, the longest first', () => {
    expect(maskSecrets(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe('a *** b ***');
    expect(maskSecrets('gho_abcdef', ['gho_abc', 'gho_abcdef'])).toBe('***');
  });

  it('ignores an empty secret', () => {
    expect(maskSecrets('text', ['', TOKEN])).toBe('text');
  });
});

describe('parseOutputFile', () => {
  it('reads key=value lines, ignoring blank ones', () => {
    expect(
      parse('\nverdict=approve\n\n   \ncount=3\n', { verdict: VERDICT, count: COUNT }),
    ).toEqual({
      ok: true,
      outputs: { verdict: 'approve', count: 3 },
    });
  });

  it('splits at the first =, so a value may hold more', () => {
    expect(parse('note=a=b=c\n', { note: NOTE })).toEqual({ ok: true, outputs: { note: 'a=b=c' } });
  });

  it('strips a trailing CR', () => {
    expect(parse('verdict=comment\r\nnote=x\r\n', { verdict: VERDICT, note: NOTE })).toEqual({
      ok: true,
      outputs: { verdict: 'comment', note: 'x' },
    });
  });

  it('lets the last write win', () => {
    expect(parse('verdict=comment\nverdict=approve\n', { verdict: VERDICT })).toEqual({
      ok: true,
      outputs: { verdict: 'approve' },
    });
  });

  it('takes an empty file when nothing is declared', () => {
    expect(parse('', {})).toEqual({ ok: true, outputs: {} });
  });

  it('has no key<<EOF form', () => {
    expect(failed('verdict<<EOF\napprove\nEOF\n', { verdict: VERDICT })).toMatch(
      /line 1: expected key=value/,
    );
  });

  it('refuses a line with no key', () => {
    expect(failed('verdict=approve\n=approve\n', { verdict: VERDICT })).toMatch(
      /line 2: expected key=value/,
    );
  });

  it('refuses an undeclared key, naming the line', () => {
    const problem = failed('verdict=approve\nscore=3\n', { verdict: VERDICT });
    expect(problem).toMatch(/line 2: score is not an output of this step \(it has: verdict\)/);
    expect(failed('score=3\n', {})).toMatch(
      /line 1: score is not an output of this step \(it declares none\)/,
    );
  });

  it('refuses a bad value, naming the line', () => {
    expect(failed('count=3\nverdict=maybe\n', { verdict: VERDICT, count: COUNT })).toMatch(
      /line 2: verdict: expected one of: approve, comment, request-changes \(got 'maybe'\)/,
    );
    expect(failed('count=three\n', { count: COUNT })).toMatch(/line 1: count: expected an integer/);
  });

  it('fails on a bad line even when a later one would fix it', () => {
    expect(failed('verdict=maybe\nverdict=approve\n', { verdict: VERDICT })).toMatch(
      /line 1: verdict/,
    );
  });

  it('refuses a missing output, naming it', () => {
    expect(failed('verdict=approve\n', { verdict: VERDICT, count: COUNT })).toMatch(
      /without setting count/,
    );
    expect(failed('', { verdict: VERDICT, count: COUNT, note: NOTE })).toMatch(
      /without setting verdict, count and note/,
    );
  });

  it('holds at most 64 KB', () => {
    const declared = {
      note: { type: 'string', maxLength: 2 * OUTPUT_FILE_CAP_BYTES } as OutputType,
    };
    const exactly = 'note=' + 'x'.repeat(OUTPUT_FILE_CAP_BYTES - 'note='.length);
    expect(parse(exactly, declared).ok).toBe(true);
    expect(failed(exactly + 'x', declared)).toMatch(/over 64 KB/);
    // Bytes, not characters: 'é' is two.
    expect(failed('note=' + 'é'.repeat(OUTPUT_FILE_CAP_BYTES / 2), declared)).toMatch(/over 64 KB/);
  });

  describe('keeps the token, and long text, out of a problem', () => {
    it('masks a bad value', () => {
      const problem = failed(`verdict=${TOKEN}\n`, { verdict: VERDICT }, [TOKEN]);
      expect(problem).not.toContain(TOKEN);
      expect(problem).toMatch(/line 1: verdict: expected one of: .* \(got '\*\*\*'\)/);
    });

    it('masks and clips an undeclared key', () => {
      const problem = failed(
        `https://x-access-token:${TOKEN}@github.com/${'o/'.repeat(40)}r?a=b\n`,
        { verdict: VERDICT },
        [TOKEN],
      );
      expect(problem).not.toContain(TOKEN);
      expect(problem).toContain('https://x-access-token:***@github.com/');
      expect(problem).toMatch(/… is not an output of this step/);
      expect(problem.length).toBeLessThan(200);
    });

    it('clips a long value', () => {
      const problem = failed('count=' + 'x'.repeat(60_000) + '\n', { count: COUNT });
      expect(problem).toMatch(/line 1: count: expected an integer \(got 'x+…'\)/);
      expect(problem.length).toBeLessThan(200);
    });

    it('masks before clipping, so no part of a token shows at the cut', () => {
      const problem = failed(`count=${'x'.repeat(60)}${TOKEN}\n`, { count: COUNT }, [TOKEN]);
      expect(problem).not.toContain('gho_');
      expect(problem).toContain(`${'x'.repeat(60)}***`);
    });

    it("says a string's length, not its text", () => {
      const problem = failed(`note=${TOKEN.repeat(20)}\n`, { note: NOTE }, [TOKEN]);
      expect(problem).toMatch(/line 1: note: expected text of at most 100 characters \(got 200\)/);
    });
  });
});

describe('layerCommandEnv', () => {
  it("layers the base, the rendered env:, Consola's variables, then git hooks off", () => {
    const env = layerCommandEnv(
      {
        PATH: '/bin',
        A: 'base',
        GH_TOKEN: 'gho_abc',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'user.name',
        GIT_CONFIG_VALUE_0: 't',
      },
      { A: 'rendered', CONSOLA_STEP: 'forged' },
      { CONSOLA_STEP: 'review', CONSOLA_RUN_ID: 'run-1' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      A: 'rendered',
      GH_TOKEN: 'gho_abc',
      CONSOLA_STEP: 'review',
      CONSOLA_RUN_ID: 'run-1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 't',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
    });
  });

  it('keeps git hooks off whatever env: says', () => {
    const env = layerCommandEnv(
      {},
      { GIT_CONFIG_COUNT: '0', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.husky' },
      {},
    );
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(env.GIT_CONFIG_VALUE_0).toBe('/dev/null');
  });
});

describe('describeFailure', () => {
  const result = (fields: Partial<CommandResult>): CommandResult => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stopped: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    ...fields,
  });

  it('names the exit code and the last line of stderr', () => {
    expect(describeFailure(result({ exitCode: 3, lastStderrLine: 'two' }), 600_000)).toBe(
      'exit 3: two',
    );
    expect(describeFailure(result({ exitCode: 1 }), 600_000)).toBe('exit 1');
  });

  it('names a signal the command was killed by', () => {
    expect(
      describeFailure(
        result({ exitCode: null, signal: 'SIGKILL', lastStderrLine: 'oom' }),
        600_000,
      ),
    ).toBe('killed by SIGKILL: oom');
  });

  it('says how long a timed-out command had, as the file writes it', () => {
    const timedOut = result({ exitCode: null, signal: 'SIGTERM', timedOut: true });
    expect(describeFailure(timedOut, 600_000)).toBe('timed out after 10m');
    expect(describeFailure(timedOut, 30_000)).toBe('timed out after 30s');
    expect(describeFailure(timedOut, 90_000)).toBe('timed out after 90s');
    expect(describeFailure(timedOut, 3_600_000)).toBe('timed out after 1h');
    expect(describeFailure(timedOut, 300)).toBe('timed out after 300ms');
  });

  it('says a stopped command may have done its work', () => {
    expect(
      describeFailure(result({ exitCode: null, signal: 'SIGTERM', stopped: true }), 600_000),
    ).toBe('Stopped while running: it may have done its work');
  });
});
