import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Only a person answers a gate, through a person-facing client (slice 3,
 * *How a run executes › `gate:`* 4): the renderer, by one IPC. No MCP tool,
 * no conductor's tool and no step tool may reach `answerGate`, so each row
 * counts the calls and says where the one allowed call sits: a second caller
 * anywhere fails it (review S5).
 */

const DESKTOP = path.resolve(__dirname, '../../..');

/** A file's text, by its path relative to `apps/desktop`. */
const read = (file: string): string => fs.readFileSync(path.join(DESKTOP, file), 'utf8');

/**
 * Every `.ts` file under `dir` (relative to `apps/desktop`) but tests and
 * test helpers, so the steps harness's own `answer` (`steps.test-helpers.ts`)
 * is not counted; each by its path relative to `apps/desktop`.
 */
function sourcesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(DESKTOP, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(child);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.test-helpers.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        found.push(child);
      }
    }
  };
  walk(dir);
  return found.sort();
}

const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

const ENGINE = '../../packages/automation-engine/src';

describe('who can answer a gate', () => {
  it('only the AUTOMATIONS_ANSWER_GATE handler calls answerGate in main, once', () => {
    const callers = sourcesUnder('src/main').filter((file) => /\.answerGate\(/.test(read(file)));
    expect(callers).toEqual(['src/main/ipc-handlers.ts']);
    const ipc = read('src/main/ipc-handlers.ts');
    expect(count(ipc, /\.answerGate\(/g)).toBe(1);
    // The handler's text: from its `ipcMain.handle(` to the next `ipcMain.handle(`.
    const handle = /ipcMain\.handle\(\s*IPC_CHANNELS\.AUTOMATIONS_ANSWER_GATE\b/.exec(ipc);
    expect(handle).not.toBeNull();
    const from = handle?.index ?? -1;
    const to = ipc.indexOf('ipcMain.handle(', from + 1);
    expect(to).toBeGreaterThan(from);
    expect(count(ipc.slice(from, to), /\.answerGate\(/g)).toBe(1);
  });

  it('no engine code calls answerGate: AutomationService.ts holds only its definition', () => {
    const callers = sourcesUnder(ENGINE).filter(
      (file) => /\banswerGate\(/.test(read(file)) && !file.endsWith('/AutomationService.ts'),
    );
    expect(callers).toEqual([]);
    const service = read(`${ENGINE}/AutomationService.ts`);
    expect(count(service, /\banswerGate\(/g)).toBe(1);
    expect(count(service, /public answerGate\(/g)).toBe(1);
  });

  it("no session's tool, conductor's tool or step tool names a gate", () => {
    for (const file of [
      'src/main/tools/consolaTools.ts',
      'src/main/conductor/ConductorTools.ts',
      `${ENGINE}/steps/stepTools.ts`,
    ])
      expect(read(file)).not.toMatch(/answerGate|AUTOMATIONS_ANSWER_GATE/);
  });

  it('the conductor offers spawn, prompt and status, and nothing else', () => {
    expect(
      [...read('src/main/conductor/ConductorTools.ts').matchAll(/'(consola_[a-z_]+)'/g)]
        .map((match) => match[1])
        .sort(),
    ).toEqual([
      'consola_group_status',
      'consola_send_prompt',
      'consola_session_status',
      'consola_spawn_session',
    ]);
  });

  it('the preload sends a gate answer on its own channel only', () => {
    const preload = read('src/preload/preload.ts');
    expect(count(preload, /IPC_CHANNELS\.AUTOMATIONS_ANSWER_GATE\b/g)).toBe(1);
    expect(preload).toMatch(
      /answerGate: \(runId, stepId, decision\) =>\s*ipcRenderer\.invoke\(IPC_CHANNELS\.AUTOMATIONS_ANSWER_GATE, runId, stepId, decision\)/,
    );
  });
});
