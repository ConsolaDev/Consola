import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { automationControl } from '../tools/consolaTools';

/**
 * Only a person answers a gate, through a person-facing client (slice 3,
 * *How a run executes › `gate:`* 4): the renderer, by one IPC. No MCP tool,
 * no conductor's tool and no step tool may reach `answerGate`, so each row
 * counts the calls and says where the one allowed call sits: a second caller
 * anywhere fails it (review S5). A name is not enough (3-A code review S4):
 * the rows also follow what can reach the method (main holds the runner in
 * one place and hands on only its members, so no name a search would miss
 * can be built on it) and its effect (one function writes a gate's answer,
 * and only `answerGate` calls it).
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
    // The name at all, not only a call: a destructured or aliased method names it too.
    const naming = sourcesUnder('src/main').filter((file) => /\banswerGate\b/.test(read(file)));
    expect(naming).toEqual(['src/main/ipc-handlers.ts']);
    const ipc = read('src/main/ipc-handlers.ts');
    expect(count(ipc, /\banswerGate\b/g)).toBe(1);
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

  it("one function writes a gate's answer, and only answerGate calls it", () => {
    const records = `${ENGINE}/steps/stepRecords.ts`;
    // Every source of the engine and of main but the one that defines it: none names it, but answerGate's own file.
    const sources = [...sourcesUnder(ENGINE), ...sourcesUnder('src/main')];
    const naming = sources.filter(
      (file) => file !== records && /\bwithGateAnswered\b/.test(read(file)),
    );
    expect(naming).toEqual([`${ENGINE}/AutomationService.ts`]);
    const service = read(`${ENGINE}/AutomationService.ts`);
    expect(count(service, /\bwithGateAnswered\(/g)).toBe(1);
    // That one call is inside answerGate: from its definition to the class's next member.
    const from = service.indexOf('  public answerGate(');
    const next = service.slice(from + 1).search(/\n {2}(public|private|protected) /);
    expect(from).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(-1);
    expect(count(service.slice(from, from + 1 + next), /\bwithGateAnswered\(/g)).toBe(1);
    // And nothing else writes an answer by hand: a gate's decision, or the decision output it gives.
    const writes = [
      /gate\s*:\s*\{[^}]*\bdecision\b/,
      /\.gate\??\.decision\s*=(?!=)/,
      /outputs\s*:\s*\{[^}]*\bdecision\b/,
    ];
    const writers = sources.filter((file) => writes.some((write) => write.test(read(file))));
    expect(writers).toEqual([records]);
  });

  it('main holds the runner in one place, and hands on only its members', () => {
    // Built once: no other module of main has a runner of its own to call answerGate on.
    const building = sourcesUnder('src/main').filter((file) =>
      /new AutomationService\(/.test(read(file)),
    );
    expect(building).toEqual(['src/main/ipc-handlers.ts']);
    // Each use of the runner names a member; a bracket would let a name be built that no row finds.
    const ipc = read('src/main/ipc-handlers.ts')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|import\b)/.test(line))
      .join('\n');
    expect(ipc).not.toMatch(/\b(automations|automationService)\s*\??\.?\s*\[/);
    // Whole, it goes only to the module's own handle, and to `automationControl`, which keeps four
    // members: each line that names it without a member, from the name on (a path's `/automations/` aside).
    const whole = [...ipc.matchAll(/(?<![/\w])(automations|automationService)\b(?!\s*\??\.)/g)].map(
      (match) => ipc.slice(match.index, ipc.indexOf('\n', match.index)).trim(),
    );
    expect(whole).toEqual([
      'automationService: AutomationService | null = null;',
      // The tools' key, then what they get.
      'automations: () => automationControl(automations),',
      'automations),',
      'automations = new AutomationService({',
      'automationService = automations;',
      'automations;',
      'automationService = null;',
    ]);
  });

  it("the tools' runner keeps list, trigger, capabilities and saveEntry, and nothing else", () => {
    const calls: string[] = [];
    const called = (line: string) => {
      calls.push(line);
    };
    const runner = {
      list: (workspaceId: string) => {
        called(`list ${workspaceId}`);
        return [];
      },
      trigger: async (_workspaceId: string, name: string) => {
        called(`trigger ${name}`);
        return null;
      },
      capabilities: (workspaceId: string) => {
        called(`capabilities ${workspaceId}`);
        return {};
      },
      saveEntry: async (workspaceId: string) => {
        called(`saveEntry ${workspaceId}`);
        return {};
      },
      answerGate: () => called('answerGate'),
      approve: () => called('approve'),
    };
    const control = automationControl(runner as unknown as Parameters<typeof automationControl>[0]);
    expect(Object.keys(control).sort()).toEqual(['capabilities', 'list', 'saveEntry', 'trigger']);
    expect(control).not.toHaveProperty('answerGate');
    expect((control as unknown as Record<string, unknown>)['answer' + 'Gate']).toBeUndefined();
    control.list('ws-1');
    void control.trigger('ws-1', 'review', {});
    control.capabilities('ws-1');
    void control.saveEntry('ws-1', '- name: x', { replace: false });
    expect(calls).toEqual(['list ws-1', 'trigger review', 'capabilities ws-1', 'saveEntry ws-1']);
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
