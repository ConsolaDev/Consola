import { describe, expect, it } from 'vitest';
import type { AutomationView, RunRecord } from '../../../shared/automations';
import { checkoutLines, checkoutNode, heldLine, writeChip } from './runCheckout';

/*
 * Slice 3-B Task 22: the run page's checkout block, above its steps, and the
 * pipeline's checkout node and write chips. Pure: what the components draw.
 */

const RUN_41: Pick<RunRecord, 'checkout' | 'waitingFor'> = {
  checkout: {
    cwd: '/w/catalog-portal-run-a1b2c3d4',
    scopeId: 'scope-catalog-portal',
    kind: 'run-owned',
    repo: 'sprocket/catalog-portal',
    branch: 'fix/SHOP-42',
    base: 'b0b0b0b0b0b0b0b0',
    head: 'p1p1p1p1p1p1p1p1',
    byPerson: [
      {
        session: 'sfix',
        before: 'c1c1c1c1c1c1c1c1',
        after: 'p1p1p1p1p1p1p1p1',
        files: 1,
        flagged: ['.github/workflows/ci.yml'],
        at: '2026-11-23T10:00:00.000Z',
      },
    ],
  },
};
const HELD: Pick<RunRecord, 'checkout' | 'waitingFor'> = {
  ...RUN_41,
  waitingFor: { session: 'sfix' },
};

describe('checkoutLines', () => {
  it("lists the checkout, the person's commits and the hold", () =>
    expect(checkoutLines(RUN_41, { sfix: 'fix' })).toEqual({
      heading: 'Checkout',
      lines: ['sprocket/catalog-portal · fix/SHOP-42', 'from b0b0b0b · now p1p1p1p'],
      byPerson: [
        { line: 'fix · 1 files · p1p1p1p', flagged: ['changed .github/workflows/ci.yml'] },
      ],
      held: undefined,
    }));

  it('says the session holding the run, by name', () => {
    expect(checkoutLines(HELD, { sfix: 'fix' })?.held).toBe(
      "waiting for you to close `fix`, open in this run's checkout",
    );
    expect(heldLine(HELD, { sfix: 'fix' })).toBe(
      "waiting for you to close `fix`, open in this run's checkout",
    );
    expect(heldLine(RUN_41, { sfix: 'fix' })).toBeUndefined();
  });

  it('names a session it no longer knows, or one the run never saw, as a session', () => {
    expect(heldLine(HELD, {})).toBe(
      "waiting for you to close a session, open in this run's checkout",
    );
    const unseen = {
      checkout: {
        ...RUN_41.checkout!,
        byPerson: [{ before: 'c1c1c1c1', after: 'd2d2d2d2', files: 3, at: '2026-11-23T10:00:00Z' }],
      },
    };
    expect(checkoutLines(unseen, { sfix: 'fix' })?.byPerson).toEqual([
      { line: 'a session · 3 files · d2d2d2d', flagged: [] },
    ]);
  });

  it('says where a removed checkout’s commit is kept', () => {
    const removed = {
      checkout: {
        ...RUN_41.checkout!,
        removed: {
          commit: 'p1p1p1p1p1p1',
          keepRef: 'refs/consola/worktrees/catalog-portal-run-a1b2c3d4',
          at: '2026-11-24T10:00:00.000Z',
        },
      },
    };
    expect(checkoutLines(removed, {})?.lines).toEqual([
      'sprocket/catalog-portal · fix/SHOP-42',
      'from b0b0b0b · now p1p1p1p',
      'removed by cleanup; its commit p1p1p1p is kept in your clone',
    ]);
  });

  it('is null for a run with no checkout of its own', () => {
    expect(checkoutLines({}, {})).toBeNull();
    expect(
      checkoutLines(
        { checkout: { cwd: '/w/catalog-portal-pr-51', kind: 'item', head: 'abc' } },
        {},
      ),
    ).toBeNull();
    // A record from before 3-B, with no kind: an item's or a scope's, never a run's own.
    expect(checkoutLines({ checkout: { cwd: '/w/x', head: 'abc' } }, {})).toBeNull();
  });
});

describe("the pipeline's checkout node and write chips", () => {
  const steps: NonNullable<AutomationView['steps']> = [
    {
      id: 'triage',
      kind: 'agent',
      summary: 'Prompt',
      agent: 'triager',
      agentFile: 'agents/triager.md',
    },
    {
      id: 'fix',
      kind: 'agent',
      summary: 'Prompt',
      agent: 'ui-bugfixer · claude-work',
      agentFile: 'agents/ui-bugfixer.md',
      writes: 'sandbox',
    },
    {
      id: 'mine',
      kind: 'agent',
      summary: 'Prompt',
      agent: 'local-fixer',
      agentFile: 'agents/local-fixer.md',
      writes: 'host',
    },
    { id: 'pr', kind: 'run', summary: 'git push' },
  ];

  it('says what a write step writes with, by its agent', () => {
    expect(steps.map(writeChip)).toEqual([
      null,
      'ui-bugfixer · writes · sandboxed',
      'local-fixer · writes · host, a convention',
      null,
    ]);
  });

  it("draws the entry's own checkout as the branch it cuts from the repository", () => {
    expect(checkoutNode({ repo: 'sprocket/catalog-portal', branch: 'fix/<ticket>' })).toEqual({
      title: 'fix/<ticket> from catalog-portal',
      repo: 'sprocket/catalog-portal',
    });
    expect(checkoutNode(undefined)).toBeNull();
  });
});
