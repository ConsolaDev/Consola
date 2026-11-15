import { describe, expect, it } from 'vitest';
import { parseFactorySpec, type RunRecord, type StepRun, type StepsAutomation } from '@consola/factory-spec';
import { agentStepLaunch, endedWithout } from './agentStep';

const automation = parseFactorySpec(`version: 1
automations:
  - name: nightly
    on: { cron: "0 9 * * 1-5" }
    scope: api
    steps:
      - id: research
        prompt: Read what changed in api overnight.
        artifacts: [notes]
      - id: write
        prompt: Write up the night.
        reads: [research.notes, research.handover]
`).automations[0] as StepsAutomation;

/** A schedule's run with `research` completed as given, and `write` next. */
function run(research: Partial<StepRun>): RunRecord {
    return {
        id: 'run-1',
        runner: 'local',
        source: 'personal',
        automationId: 'nightly',
        actionName: 'steps',
        actionVersion: 'v',
        mode: 'auto',
        trigger: { kind: 'cron', at: '2026-11-16T09:00:00.000Z' },
        status: 'running',
        steps: [
            { id: 'research', kind: 'agent', status: 'completed', attempt: 1, ...research },
            { id: 'write', kind: 'agent', status: 'queued', attempt: 1 },
        ],
        attribution: { automationId: 'nightly', actionName: 'steps', triggerKind: 'cron', workspaceId: 'ws-1' },
        createdAt: '2026-11-16T09:00:00.000Z',
        updatedAt: '2026-11-16T09:00:00.000Z',
    };
}

describe('agentStepLaunch', () => {
    it('lists only the documents an earlier step was recorded writing', () => {
        const launch = agentStepLaunch({
            workspaceId: 'ws-1',
            run: run({ artifacts: [{ name: 'notes', bytes: 2048 }] }),
            definition: { automation, version: 'v', actions: {} },
            stepId: 'write',
            checkout: { cwd: '/code/api', scopeId: 'scope-api' },
        });
        if (!launch.ok) throw new Error(launch.error);
        // The handover it never wrote is left out, not listed as something to read.
        expect(launch.request.prompt).toContain('\n  - research.notes (from step "research", 2.0 KB)\nRead them with consola_read_artifact.');
        expect(launch.request.prompt).not.toContain('research.handover');
    });
});

describe('endedWithout', () => {
    it('names what a clean exit left undone, or nothing', () => {
        expect(endedWithout({ outputs: ['verdict'], artifacts: [] })).toBe('ended without setting verdict');
        expect(endedWithout({ outputs: [], artifacts: ['notes'] })).toBe('ended without writing notes');
        expect(endedWithout({ outputs: ['verdict', 'confidence'], artifacts: ['notes'] })).toBe(
            'ended without setting verdict and confidence, and without writing notes'
        );
        expect(endedWithout({ outputs: [], artifacts: [] })).toBeNull();
    });
});
