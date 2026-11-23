import { describe, expect, it } from 'vitest';
import {
  factoryFilesOf,
  isStepsEntry,
  parseAutomationEntry,
  parseFactory,
  type AgentDefinition,
  type StepsAutomation,
} from '@consola/factory-spec';
import { writesNotYet } from './writesLater';

/*
 * A key the format accepts and the engine does not run yet stops the entry,
 * in words (slice 3-B, Call 2): a write agent until a host holds it
 * (Task 13). A checkout the run owns left the list in Task 12, for a rule
 * that stays (`NO_RUN_CHECKOUTS`, `AutomationService.writing.test.ts`).
 */

function stepsEntry(
  head: string,
  steps = '    - id: look\n      prompt: Look.\n',
): StepsAutomation {
  const parsed = parseAutomationEntry(`- name: fix\n${head}  steps:\n${steps}`);
  if (!parsed.ok || !isStepsEntry(parsed.automation)) throw new Error(JSON.stringify(parsed));
  return parsed.automation;
}

const RUN_OWNED = '  on: manual\n  checkout: { repo: sprocket/catalog-portal, branch: "fix/a" }\n';

/** An agent as `parseFactory` keeps it, with its `tools:` (and an environment, for a write agent). */
const agent = (tools: string): AgentDefinition => {
  const read = parseFactory(
    factoryFilesOf({
      'agents/fixer.md': `---\ntools: ${tools}\n${tools === 'read-only' ? '' : 'environment: sandboxed\n'}---\nFix it.\n`,
      'environments/sandboxed.yaml': 'isolation: sandbox\n',
    }),
  );
  if (!read.agents.fixer) throw new Error(JSON.stringify(read.issues));
  return read.agents.fixer;
};

describe('writesNotYet', () => {
  it.each(['edit', 'write'])('refuses an agent with tools: %s, in a loop too', (tools) => {
    const steps =
      '    - id: loop\n      repeat: { max: 2, until: steps.fix.done }\n      steps:\n        - id: fix\n          agent: fixer\n          outputs: { done: boolean }\n';
    expect(
      writesNotYet(stepsEntry('  on: manual\n  scope: app\n', steps), { fixer: agent(tools) }),
    ).toBe(`\`tools: ${tools}\` runs from the next update; this automation does not run yet.`);
  });

  it('passes what runs today: an item checkout, a scope, a read-only agent, a checkout the run owns', () => {
    expect(writesNotYet(stepsEntry(RUN_OWNED), {})).toBeNull();
    expect(
      writesNotYet(
        stepsEntry('  on: { github: pull_request.review_requested }\n  checkout: { pr: item }\n'),
        {},
      ),
    ).toBeNull();
    expect(
      writesNotYet(
        stepsEntry('  on: manual\n  scope: app\n', '    - id: fix\n      agent: fixer\n'),
        {
          fixer: agent('read-only'),
        },
      ),
    ).toBeNull();
  });
});
