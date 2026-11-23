import { describe, expect, it } from 'vitest';
import type { SecretBindingView } from '../../../shared/automations';
import {
  SECRETS_TRUST_LINE,
  needsBinding,
  secretCardLines,
  secretPlacesOf,
  type SecretPlace,
} from './secretWords';

const UTC = { timeZone: 'UTC' };
const AT = '2026-11-20T12:00:00.000Z';
const keychain = {
  kind: 'keychain' as const,
  label: 'the keychain (consola/ws-1/personal · PAGER_TOKEN)',
  changedAt: AT,
};
const env = {
  kind: 'env' as const,
  label: 'your login environment (STUB_PAGER_TOKEN)',
  changedAt: AT,
};

const lines = (places: SecretPlace[], secrets: SecretBindingView[] | undefined) =>
  secretCardLines({ automation: 'page-on-call', places, secrets, at: UTC });

describe('secretCardLines', () => {
  it('says where a bound name goes and where it is bound, then the trust line once, last', () => {
    expect(
      lines(
        [{ step: 'page', names: ['PAGER_TOKEN'] }],
        [
          {
            name: 'PAGER_TOKEN',
            binding: keychain,
            uses: [{ automation: 'page-on-call', step: 'page', accepted: true }],
          },
        ],
      ),
    ).toEqual([
      '`PAGER_TOKEN` → command `page`, as its environment variable · bound on this Mac to the keychain (consola/ws-1/personal · PAGER_TOKEN), last changed 20 Nov',
      SECRETS_TRUST_LINE,
    ]);
    expect(SECRETS_TRUST_LINE).toBe(
      "Where a secret is bound is this Mac's setting, not the file's: changing it does not ask again.",
    );
  });

  it('says an unbound name is not bound on this Mac', () => {
    expect(
      lines(
        [{ step: 'page', names: ['PAGER_TOKEN'] }],
        [
          {
            name: 'PAGER_TOKEN',
            uses: [{ automation: 'page-on-call', step: 'page', accepted: false }],
          },
        ],
      )[0],
    ).toBe('`PAGER_TOKEN` → command `page`, as its environment variable · not bound on this Mac');
  });

  it('reads a name an older snapshot does not list as unbound', () => {
    expect(lines([{ step: 'page', names: ['PAGER_TOKEN'] }], [])[0]).toBe(
      '`PAGER_TOKEN` → command `page`, as its environment variable · not bound on this Mac',
    );
    expect(lines([{ step: 'page', names: ['PAGER_TOKEN'] }], undefined)[0]).toBe(
      '`PAGER_TOKEN` → command `page`, as its environment variable · not bound on this Mac',
    );
  });

  it('names the check as a destination of its own', () => {
    expect(
      lines(
        [{ check: true, names: ['TRACKER_TOKEN'] }],
        [
          {
            name: 'TRACKER_TOKEN',
            binding: env,
            uses: [{ automation: 'page-on-call', check: true, accepted: false }],
          },
        ],
      )[0],
    ).toBe(
      "`TRACKER_TOKEN` → this automation's check, as its environment variable · bound on this Mac to your login environment (STUB_PAGER_TOKEN), last changed 20 Nov",
    );
  });

  it('lists every other automation a name goes to, accepted or not, and never the card’s own uses', () => {
    const secrets: SecretBindingView[] = [
      {
        name: 'PAGER_TOKEN',
        binding: keychain,
        uses: [
          { automation: 'page-on-call', step: 'page', accepted: false },
          { automation: 'page-on-call', check: true, accepted: false },
          { automation: 'nightly', step: 'post', accepted: true },
          { automation: 'watch-tickets', check: true, accepted: false },
        ],
      },
    ];
    expect(
      lines(
        [
          { step: 'page', names: ['PAGER_TOKEN'] },
          { check: true, names: ['PAGER_TOKEN'] },
        ],
        secrets,
      ),
    ).toEqual([
      '`PAGER_TOKEN` → command `page`, as its environment variable · bound on this Mac to the keychain (consola/ws-1/personal · PAGER_TOKEN), last changed 20 Nov',
      '`PAGER_TOKEN` also goes to `nightly` · step `post` (accepted)',
      '`PAGER_TOKEN` also goes to `watch-tickets` · its check (not accepted yet)',
      "`PAGER_TOKEN` → this automation's check, as its environment variable · bound on this Mac to the keychain (consola/ws-1/personal · PAGER_TOKEN), last changed 20 Nov",
      SECRETS_TRUST_LINE,
    ]);
  });

  it('flags two names bound to one reference, once', () => {
    const secrets: SecretBindingView[] = [
      {
        name: 'PAGER_TOKEN',
        binding: env,
        uses: [{ automation: 'page-on-call', step: 'page', accepted: true }],
        sameAs: ['TRACKER_TOKEN'],
      },
      {
        name: 'TRACKER_TOKEN',
        binding: env,
        uses: [{ automation: 'page-on-call', check: true, accepted: true }],
        sameAs: ['PAGER_TOKEN'],
      },
    ];
    const card = lines(
      [
        { step: 'page', names: ['PAGER_TOKEN'] },
        { check: true, names: ['TRACKER_TOKEN'] },
      ],
      secrets,
    );
    expect(card.filter((line) => line.includes('are the same'))).toEqual([
      '`PAGER_TOKEN` and `TRACKER_TOKEN` are the same variable',
    ]);
    expect(card[card.length - 1]).toBe(SECRETS_TRUST_LINE);
  });

  it('is empty, with no trust line, when nothing names a secret', () => {
    expect(lines([], [])).toEqual([]);
    expect(lines([], undefined)).toEqual([]);
  });
});

describe('needsBinding', () => {
  const places: SecretPlace[] = [
    { step: 'page', names: ['PAGER_TOKEN'] },
    { check: true, names: ['TRACKER_TOKEN'] },
  ];
  const bound = (name: string): SecretBindingView => ({ name, binding: env, uses: [] });

  it('is true for any unbound name, or one the snapshot does not list', () => {
    expect(needsBinding(places, [bound('PAGER_TOKEN'), { name: 'TRACKER_TOKEN', uses: [] }])).toBe(
      true,
    );
    expect(needsBinding(places, [bound('PAGER_TOKEN')])).toBe(true);
    expect(needsBinding(places, undefined)).toBe(true);
  });

  it('is false when every name is bound, or nothing names one', () => {
    expect(needsBinding(places, [bound('PAGER_TOKEN'), bound('TRACKER_TOKEN')])).toBe(false);
    expect(needsBinding([], undefined)).toBe(false);
  });
});

describe('secretPlacesOf (review S1)', () => {
  const views: SecretBindingView[] = [
    {
      name: 'PAGER_TOKEN',
      binding: env,
      uses: [
        { automation: 'page-on-call', step: 'page', accepted: true },
        { automation: 'nightly', step: 'post', accepted: true },
      ],
    },
    {
      name: 'TRACKER_TOKEN',
      uses: [
        { automation: 'page-on-call', step: 'post', accepted: true },
        { automation: 'page-on-call', check: true, accepted: true },
      ],
    },
  ];

  it('builds a card’s places from its own uses: by step, then the check', () => {
    expect(secretPlacesOf('page-on-call', views)).toEqual([
      { step: 'page', names: ['PAGER_TOKEN'] },
      { step: 'post', names: ['TRACKER_TOKEN'] },
      { check: true, names: ['TRACKER_TOKEN'] },
    ]);
    expect(secretPlacesOf('nightly', views)).toEqual([{ step: 'post', names: ['PAGER_TOKEN'] }]);
  });

  it('groups a step’s names, and has none without a snapshot', () => {
    expect(
      secretPlacesOf('page-on-call', [
        { name: 'A_TOKEN', uses: [{ automation: 'page-on-call', step: 'page', accepted: true }] },
        { name: 'B_TOKEN', uses: [{ automation: 'page-on-call', step: 'page', accepted: true }] },
      ]),
    ).toEqual([{ step: 'page', names: ['A_TOKEN', 'B_TOKEN'] }]);
    expect(secretPlacesOf('page-on-call', undefined)).toEqual([]);
    expect(secretPlacesOf('someone-else', views)).toEqual([]);
  });
});

describe('a secret that goes to a server (5a-2)', () => {
  const slackUse = {
    automation: 'support-briefing',
    step: 'post',
    server: { name: 'slack', transport: 'stdio' as const },
    accepted: false,
  };
  const views = (transport: 'stdio' | 'http', name = 'slack'): SecretBindingView[] => [
    {
      name: 'SLACK_BOT_TOKEN',
      binding: env,
      uses: [{ ...slackUse, server: { name, transport } }],
    },
  ];

  it('says a server’s secret goes to the server, as its environment or in a header', () => {
    const at = (secrets: SecretBindingView[]) =>
      secretCardLines({
        automation: 'support-briefing',
        places: secretPlacesOf('support-briefing', secrets),
        secrets,
        at: UTC,
      });
    expect(at(views('stdio'))).toEqual([
      '`SLACK_BOT_TOKEN` → server `slack`, as its environment · bound on this Mac to your login environment (STUB_PAGER_TOKEN), last changed 20 Nov',
      SECRETS_TRUST_LINE,
    ]);
    expect(at(views('http', 'tracker'))[0]).toBe(
      '`SLACK_BOT_TOKEN` → server `tracker`, in a header · bound on this Mac to your login environment (STUB_PAGER_TOKEN), last changed 20 Nov',
    );
  });

  it('keeps the call’s step as its place, with its server', () => {
    expect(secretPlacesOf('support-briefing', views('stdio'))).toEqual([
      { step: 'post', names: ['SLACK_BOT_TOKEN'], server: { name: 'slack', transport: 'stdio' } },
    ]);
  });
});
