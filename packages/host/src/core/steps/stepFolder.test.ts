import { describe, expect, it } from 'vite-plus/test';
import {
  checkStepFolder,
  declarationOf,
  folderStateOf,
  missingFrom,
  missingSentence,
  nothingMissing,
  readDeclaration,
} from './stepFolder.ts';
import { MAX_ARTIFACT_BYTES } from './stepTools.ts';

const DECLARATION = declarationOf({
  outputs: { verdict: { type: 'enum', values: ['approve', 'comment'] } },
  allowedArtifacts: ['handover', 'review'],
  requiredArtifacts: ['handover'],
  readable: [{ name: 'triage.handover', content: 'Sprocket triage.' }],
});

describe('a step’s folder', () => {
  it('declares what the request says, and reads the declaration back', () => {
    expect(DECLARATION).toEqual({
      outputs: { verdict: { type: 'enum', values: ['approve', 'comment'] } },
      writable: ['handover', 'review'],
      required: ['handover'],
      readable: [{ name: 'triage.handover', content: 'Sprocket triage.' }],
    });
    expect(readDeclaration(JSON.stringify(DECLARATION))).toEqual(DECLARATION);
  });

  it('reads no declaration the runner would not write, and keeps only document names', () => {
    expect(readDeclaration('{')).toBeNull();
    expect(
      readDeclaration(JSON.stringify({ ...DECLARATION, outputs: { a: { type: 'date' } } })),
    ).toBeNull();
    expect(readDeclaration(JSON.stringify({ ...DECLARATION, readable: [{ name: 1 }] }))).toBeNull();
    expect(
      readDeclaration(JSON.stringify({ ...DECLARATION, writable: ['handover', '../x'] }))?.writable,
    ).toEqual(['handover']);
  });

  it('gives the step tools the valid outputs and the documents of names the step writes', () => {
    expect(
      folderStateOf(DECLARATION, JSON.stringify({ verdict: 'comment', extra: 1 }), [
        { name: 'handover', text: 'done' },
        { name: 'review', text: null },
      ]),
    ).toEqual({ outputs: { verdict: 'comment' }, artifacts: { handover: 'done' } });
  });

  it('is checked again by the runner: a tampered output or document is never taken', () => {
    const checked = checkStepFolder(
      DECLARATION,
      JSON.stringify({ verdict: 'merge it now', planted: 'x' }),
      [
        { name: 'handover', text: 'The handover.' },
        { name: 'review', text: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) },
        { name: 'credentials', text: 'stolen' },
      ],
    );
    expect(checked.outputs).toEqual({});
    expect(checked.artifacts).toEqual([{ name: 'handover', content: 'The handover.' }]);
    // Each refusal names what it refused, never the value the sandbox wrote.
    expect(checked.refused.join('\n')).not.toContain('merge it now');
    expect(checked.refused.join('\n')).not.toContain('stolen');
    expect(checked.refused).toHaveLength(4);
    expect(checkStepFolder(DECLARATION, '[1]', []).outputs).toEqual({});
    expect(checkStepFolder(DECLARATION, 'not json', []).outputs).toEqual({});
  });

  it('says what is missing, and the sentence a step fails with', () => {
    const empty = checkStepFolder(DECLARATION, null, []);
    const missing = missingFrom(DECLARATION, empty);
    expect(missing).toEqual({ outputs: ['verdict'], artifacts: ['handover'] });
    expect(nothingMissing(missing)).toBe(false);
    expect(missingSentence(missing)).toBe(
      'The step ended without the output verdict and the document handover, even after its reminder.',
    );
    const done = checkStepFolder(DECLARATION, JSON.stringify({ verdict: 'approve' }), [
      { name: 'handover', text: 'ok' },
    ]);
    expect(nothingMissing(missingFrom(DECLARATION, done))).toBe(true);
  });
});
