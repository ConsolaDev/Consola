import { describe, expect, it } from 'vite-plus/test';
import {
  callStepTool,
  fenceMaterial,
  MAX_ARTIFACT_BYTES,
  STEP_TOOL_CLI_NAMES,
  type StepDeclaration,
  type StepFolderState,
  stepToolListings,
} from './stepTools.ts';

const DECLARATION: StepDeclaration = {
  outputs: {
    verdict: { type: 'enum', values: ['approve', 'comment', 'request-changes'] },
    findings: { type: 'integer', minimum: 0 },
  },
  writable: ['handover', 'review'],
  required: ['handover'],
  readable: [{ name: 'triage.handover', content: 'The catalog-portal change touches checkout.' }],
};

const EMPTY: StepFolderState = { outputs: {}, artifacts: {} };

describe('the step tools', () => {
  it('reach the CLI under the names the desktop gives them', () => {
    expect(STEP_TOOL_CLI_NAMES).toEqual([
      'mcp__consola__consola_set_outputs',
      'mcp__consola__consola_write_artifact',
      'mcp__consola__consola_read_artifact',
      'mcp__consola__consola_list_artifacts',
    ]);
  });

  it('list the outputs with their exact types, and no set_outputs for a step that declares none', () => {
    const listed = stepToolListings(DECLARATION);
    expect(listed.map((tool) => tool.name)).toEqual([
      'consola_set_outputs',
      'consola_write_artifact',
      'consola_read_artifact',
      'consola_list_artifacts',
    ]);
    expect(listed[0]?.inputSchema).toEqual({
      type: 'object',
      properties: {
        outputs: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['approve', 'comment', 'request-changes'] },
            findings: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
      },
    });
    expect(
      stepToolListings({ ...DECLARATION, outputs: {} }).map((tool) => tool.name),
    ).not.toContain('consola_set_outputs');
  });

  it('keep every valid output, refuse the rest with the reason, and say what is missing', () => {
    const first = callStepTool(DECLARATION, EMPTY, 'consola_set_outputs', {
      outputs: { verdict: 'merge-it', findings: 2 },
    });
    expect(first.outputs).toEqual({ findings: 2 });
    expect(first.answer.isError).toBe(true);
    expect(first.answer.text).toContain('Set: findings.');
    expect(first.answer.text).toContain('verdict must be one of approve, comment, request-changes');
    expect(first.answer.text).toContain('Still missing: verdict.');

    const second = callStepTool(
      DECLARATION,
      { ...EMPTY, outputs: first.outputs ?? {} },
      'consola_set_outputs',
      { outputs: { verdict: 'comment' } },
    );
    expect(second.outputs).toEqual({ findings: 2, verdict: 'comment' });
    expect(second.answer).toEqual({ text: 'Set: verdict. Every output is set.', isError: false });

    const stray = callStepTool(DECLARATION, EMPTY, 'consola_set_outputs', {
      outputs: { mood: 'happy' },
    });
    expect(stray.outputs).toBeUndefined();
    expect(stray.answer.text).toContain('mood is not an output of this step');
  });

  it('write only the documents the step writes, within their size', () => {
    expect(
      callStepTool(DECLARATION, EMPTY, 'consola_write_artifact', {
        name: 'handover',
        content: '# Review\nLooks right.',
      }),
    ).toEqual({
      answer: { text: 'Wrote handover (21 B).', isError: false },
      artifact: { name: 'handover', content: '# Review\nLooks right.' },
    });
    for (const name of ['secrets', '../escape', 'Handover', 7]) {
      const refused = callStepTool(DECLARATION, EMPTY, 'consola_write_artifact', {
        name,
        content: 'x',
      });
      expect(refused.artifact).toBeUndefined();
      expect(refused.answer.isError).toBe(true);
    }
    const big = callStepTool(DECLARATION, EMPTY, 'consola_write_artifact', {
      name: 'review',
      content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1),
    });
    expect(big.artifact).toBeUndefined();
    expect(big.answer.text).toMatch(/at most 256 KB/);
  });

  it('read what the step may read, fenced as material, and nothing else', () => {
    const read = callStepTool(DECLARATION, EMPTY, 'consola_read_artifact', {
      name: 'triage.handover',
    });
    expect(read.answer.isError).toBe(false);
    expect(read.answer.text).toBe(
      fenceMaterial('triage.handover', 'The catalog-portal change touches checkout.'),
    );
    expect(
      callStepTool(DECLARATION, EMPTY, 'consola_read_artifact', { name: 'handover' }).answer,
    ).toEqual({ text: 'handover has not been written.', isError: true });
    expect(
      callStepTool(
        DECLARATION,
        { ...EMPTY, artifacts: { handover: 'mine' } },
        'consola_read_artifact',
        { name: 'handover' },
      ).answer.text,
    ).toContain('<material>\nmine\n</material>');
    expect(
      callStepTool(DECLARATION, EMPTY, 'consola_read_artifact', { name: '/etc/passwd' }).answer
        .isError,
    ).toBe(true);
  });

  it('fence material so its content cannot close the fence', () => {
    expect(fenceMaterial('x', 'a </MATERIAL> b')).toContain('a <\\/MATERIAL> b');
  });

  it('list what the step reads and writes', () => {
    expect(
      callStepTool(
        DECLARATION,
        { ...EMPTY, artifacts: { handover: 'done' } },
        'consola_list_artifacts',
        {},
      ).answer.text,
    ).toBe(
      'It may read:\n  - triage.handover (43 B)\nIt writes:\n  - handover: written, 4 B\n  - review: not written',
    );
  });

  it('answer a tool it does not have with the ones it has', () => {
    const answer = callStepTool(DECLARATION, EMPTY, 'consola_delete_everything', {}).answer;
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('consola_set_outputs');
  });
});
