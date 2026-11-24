import type { SecretUse } from '@consola/factory-spec';
import { describe, expect, it } from 'vitest';
import type { SecretBinding } from './secretsPort';
import { buildSecretsView, type SecretBindingView } from './secretsView';

const SLACK: SecretBinding = {
  kind: 'keychain',
  label: 'the keychain (consola/ws-1/personal · SLACK_BOT_TOKEN)',
  changedAt: '2026-11-20T09:00:00.000Z',
};
const TRACKER: SecretBinding = {
  kind: '1password',
  label: '1Password (op://Ops/Tracker/credential)',
  changedAt: '2026-11-21T10:30:00.000Z',
  program: '/opt/homebrew/bin/op',
};

const USES: SecretUse[] = [
  { name: 'SLACK_BOT_TOKEN', automation: 'post-digest', step: 'post' },
  { name: 'PAGER_TOKEN', automation: 'post-digest', step: 'page' },
  { name: 'SLACK_BOT_TOKEN', automation: 'watch-alerts', check: true },
];

/** Every view this file builds, so their shapes are checked over the real outputs. */
const built: SecretBindingView[][] = [];
function build(fingerprints: Record<string, string | null>) {
  const bindings: Record<string, SecretBinding> = {
    SLACK_BOT_TOKEN: SLACK,
    TRACKER_TOKEN: TRACKER,
  };
  const views = buildSecretsView({
    uses: USES,
    accepted: (automation) => automation === 'post-digest',
    bound: new Set(Object.keys(bindings)),
    describe: (name) => bindings[name] ?? null,
    fingerprint: (name) => fingerprints[name] ?? null,
  });
  built.push(views);
  return views;
}

describe('buildSecretsView', () => {
  it('lists every used or bound name, sorted, each with its binding and every use', () => {
    expect(build({ SLACK_BOT_TOKEN: 'fp-slack', TRACKER_TOKEN: 'fp-tracker' })).toEqual([
      {
        name: 'PAGER_TOKEN',
        uses: [{ automation: 'post-digest', step: 'page', accepted: true }],
      },
      {
        name: 'SLACK_BOT_TOKEN',
        binding: SLACK,
        uses: [
          { automation: 'post-digest', step: 'post', accepted: true },
          { automation: 'watch-alerts', check: true, accepted: false },
        ],
      },
      { name: 'TRACKER_TOKEN', binding: TRACKER, uses: [] },
    ]);
  });

  it('flags names bound to one reference, never an unbound one', () => {
    const views = build({
      SLACK_BOT_TOKEN: 'fp-same',
      TRACKER_TOKEN: 'fp-same',
      PAGER_TOKEN: null,
    });
    const byName = Object.fromEntries(views.map((view) => [view.name, view]));
    expect(byName.SLACK_BOT_TOKEN.sameAs).toEqual(['TRACKER_TOKEN']);
    expect(byName.TRACKER_TOKEN.sameAs).toEqual(['SLACK_BOT_TOKEN']);
    expect('sameAs' in byName.PAGER_TOKEN).toBe(false);
  });

  it('has no field a value could ride in', () => {
    build({});
    expect(built.length).toBeGreaterThanOrEqual(3);
    for (const views of built)
      for (const view of views) {
        for (const key of Object.keys(view))
          expect(['name', 'binding', 'uses', 'sameAs'], key).toContain(key);
        for (const key of Object.keys(view.binding ?? {}))
          expect(['kind', 'label', 'changedAt', 'program'], key).toContain(key);
        for (const use of view.uses)
          for (const key of Object.keys(use))
            expect(['automation', 'step', 'check', 'accepted'], key).toContain(key);
      }
  });
});
