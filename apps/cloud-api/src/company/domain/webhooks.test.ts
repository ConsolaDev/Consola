import { describe, expect, it } from 'vitest';
import {
  installationOfEvent,
  isGitHubDeliveryId,
  isGitHubEventName,
  readDeliveryHeaders,
} from './webhooks.js';

const deliveryId = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

describe('readDeliveryHeaders', () => {
  it("reads the event's name and GitHub's id of the delivery", () => {
    expect(readDeliveryHeaders({ event: 'pull_request', deliveryId })).toEqual({
      ok: true,
      event: 'pull_request',
      deliveryId,
    });
  });

  it('refuses a delivery that names no event, or one that is not a name', () => {
    expect(readDeliveryHeaders({ deliveryId })).toEqual({
      ok: false,
      reason: 'it has no X-GitHub-Event',
    });
    expect(readDeliveryHeaders({ event: 'Pull Request', deliveryId })).toEqual({
      ok: false,
      reason: "its X-GitHub-Event is not the name of one of GitHub's events",
    });
  });

  it('refuses a delivery with no id, or an id that is not one', () => {
    expect(readDeliveryHeaders({ event: 'push' })).toEqual({
      ok: false,
      reason: 'it has no X-GitHub-Delivery',
    });
    expect(readDeliveryHeaders({ event: 'push', deliveryId: `${deliveryId}\nforged` })).toEqual({
      ok: false,
      reason: "its X-GitHub-Delivery is not GitHub's id of a delivery",
    });
  });
});

describe('installationOfEvent', () => {
  it('is the installation the payload names', () => {
    expect(installationOfEvent({ action: 'opened', installation: { id: 41 } })).toBe(41);
  });

  it.each([
    ['names none', { action: 'revoked', sender: { login: 'dana' } }],
    ['names one that is not an object', { installation: 41 }],
    ['names one with no id', { installation: { node_id: 'MDQ6' } }],
    ['names an id that is a string', { installation: { id: '41' } }],
    ['names an id below 1', { installation: { id: 0 } }],
    ['names an id that is not whole', { installation: { id: 4.1 } }],
    ['names an id past what JSON keeps exactly', { installation: { id: 2 ** 53 } }],
  ])('is null when the payload %s', (_what, payload) => {
    expect(installationOfEvent(payload)).toBeNull();
  });
});

describe('isGitHubDeliveryId', () => {
  it('takes the GUID GitHub names a delivery with', () => {
    expect(isGitHubDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
  });

  it.each([
    ['nothing', ''],
    ['a space', '72d3162e cc78'],
    ['a line break', '72d3162e\ncc78'],
    ['a slash', '../72d3162e'],
    ['too long an id', 'a'.repeat(65)],
    ['a number', 72],
  ])('refuses %s', (_what, value) => {
    expect(isGitHubDeliveryId(value)).toBe(false);
  });
});

describe('isGitHubEventName', () => {
  it.each(['pull_request', 'push', 'installation_repositories', 'check_run'])(
    'takes %s',
    (name) => {
      expect(isGitHubEventName(name)).toBe(true);
    },
  );

  it.each([
    ['nothing', ''],
    ['capitals', 'Pull_Request'],
    ['a dot', 'pull_request.opened'],
    ['a line break', 'push\n'],
    ['too long a name', `p${'a'.repeat(64)}`],
    ['a number', 1],
  ])('refuses %s', (_what, value) => {
    expect(isGitHubEventName(value)).toBe(false);
  });
});
