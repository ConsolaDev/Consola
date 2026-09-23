import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDisplayName } from './ClaudeSessionIndex';

/**
 * Exercised through a real on-disk config directory: the module reads
 * Claude's own storage, so the fixture is the storage format itself. Each
 * test gets a fresh directory, which also keeps the module's mtime-keyed
 * index cache from ever seeing the same path twice.
 */

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

let configDir: string;
let projectDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-index-'));
  projectDir = path.join(configDir, 'projects', '-Users-someone-code-repo');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

function writeTranscript(userMessages: string[]): void {
  const lines = userMessages.map((content) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content } })
  );
  fs.writeFileSync(path.join(projectDir, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

describe('getDisplayName from the transcript', () => {
  it('names a session from its opening prompt, marked as a prompt-derived name', () => {
    writeTranscript(['Fix the login redirect loop']);

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Fix the login redirect loop',
      source: 'prompt',
    });
  });

  it('skips <-wrapped command messages to reach real prose', () => {
    writeTranscript([
      '<command-message>brainstorm</command-message><command-name>/brainstorm</command-name>',
      'Design the session sidebar',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Design the session sidebar');
  });

  it('skips a message that opens with a markdown heading', () => {
    writeTranscript(['# Brainstorming\n\nYou MUST follow this process.', 'Rework the status dots']);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Rework the status dots');
  });

  it('skips a skill preamble message', () => {
    writeTranscript([
      'Base directory for this skill: /home/user/.claude/skills/tdd\n\nWrite the test first.',
      'Add retry to the uploader',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('Add retry to the uploader');
  });

  it("prefers the text after ARGUMENTS: — the user's own words in a slash-command session", () => {
    writeTranscript([
      '# Some Skill\n\nInstructions the user never typed.\n\nARGUMENTS: make the sidebar readable at a glance',
    ]);

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'make the sidebar readable at a glance',
      source: 'prompt',
    });
  });

  it('falls past an ARGUMENTS: marker with nothing after it', () => {
    writeTranscript(['# Some Skill\n\nARGUMENTS:', 'The real question']);

    expect(getDisplayName(SESSION_ID, configDir)?.name).toBe('The real question');
  });

  it('is null when every user message is preamble', () => {
    writeTranscript(['<command-name>/foo</command-name>', '# Heading only']);

    expect(getDisplayName(SESSION_ID, configDir)).toBeNull();
  });

  it('collapses whitespace and truncates long names', () => {
    writeTranscript([`Please   ${'x'.repeat(80)}`]);

    const result = getDisplayName(SESSION_ID, configDir);
    expect(result?.name.length).toBeLessThanOrEqual(60);
    expect(result?.name.endsWith('…')).toBe(true);
    expect(result?.name.startsWith('Please x')).toBe(true);
  });
});

describe('getDisplayName from the index', () => {
  it("prefers the CLI's own summary and marks it as such", () => {
    writeTranscript(['Fix the login redirect loop']);
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: SESSION_ID, summary: 'Login redirect fix' }],
      })
    );

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Login redirect fix',
      source: 'summary',
    });
  });

  it('an index entry with no summary yet still yields a prompt-sourced name', () => {
    writeTranscript(['Fix the login redirect loop']);
    fs.writeFileSync(
      path.join(projectDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: SESSION_ID, summary: '', firstPrompt: 'Fix the login redirect loop' }],
      })
    );

    expect(getDisplayName(SESSION_ID, configDir)).toEqual({
      name: 'Fix the login redirect loop',
      source: 'prompt',
    });
  });
});
