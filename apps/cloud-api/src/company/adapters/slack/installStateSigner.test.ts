import { describe, expect, it } from 'vitest';
import { createInstallStateSigner } from '../github/installStateSigner.js';
import { createSlackInstallStateSigner } from './installStateSigner.js';

const SECRET = 'sprocket-test-secret-that-is-long-enough-to-sign-with';
const state = {
  workspaceId: 'sprocket',
  factoryId: 'factory-1',
  personId: 'person-dana',
  expiresAt: 1_795_000_600,
};

describe("an Add to Slack's state", () => {
  it('reads back what it signed', () => {
    const signer = createSlackInstallStateSigner(SECRET);
    expect(signer.read(signer.sign(state))).toEqual(state);
  });

  it('reads nothing another key signed, changed, or of another shape', () => {
    const signer = createSlackInstallStateSigner(SECRET);
    const signed = signer.sign(state);
    const [body = '', mac = ''] = signed.split('.');
    const other = createSlackInstallStateSigner(`${SECRET}-other`).sign(state);
    const changed = Buffer.from(JSON.stringify({ ...state, factoryId: 'factory-2' })).toString(
      'base64url',
    );
    for (const token of [
      other,
      `${changed}.${mac}`,
      `${body}.`,
      body,
      `${body}.${mac}.x`,
      'x'.repeat(2000),
      '',
    ]) {
      expect(signer.read(token)).toBeNull();
    }
  });

  it("is never a GitHub Connect's state, though both derive from one secret", () => {
    const slack = createSlackInstallStateSigner(SECRET);
    const gitHub = createInstallStateSigner(SECRET);
    const [body = ''] = slack.sign(state).split('.');
    expect(gitHub.read(slack.sign(state))).toBeNull();
    const gitHubState = { workspaceId: 'sprocket', personId: 'p', sessionId: 's', expiresAt: 1 };
    expect(slack.read(gitHub.sign(gitHubState))).toBeNull();
    expect(body).not.toBe('');
  });
});
