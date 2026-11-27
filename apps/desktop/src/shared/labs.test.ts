import { describe, expect, it } from 'vitest';
import { NO_LABS, parseLabs } from './labs';

describe('parseLabs', () => {
  it('turns Automations on only for a literal true', () => {
    expect(parseLabs('{"automations": true}')).toEqual({ automations: true });
    expect(parseLabs('{"automations": "true"}')).toEqual(NO_LABS);
    expect(parseLabs('{"automations": 1}')).toEqual(NO_LABS);
    expect(parseLabs('{"automations": false}')).toEqual(NO_LABS);
  });

  it('turns nothing on for no file or one it cannot read', () => {
    expect(parseLabs(null)).toEqual(NO_LABS);
    expect(parseLabs(undefined)).toEqual(NO_LABS);
    expect(parseLabs('')).toEqual(NO_LABS);
    expect(parseLabs('{automations: true')).toEqual(NO_LABS);
    expect(parseLabs('true')).toEqual(NO_LABS);
    expect(parseLabs('[true]')).toEqual(NO_LABS);
    expect(parseLabs('null')).toEqual(NO_LABS);
  });

  it('ignores labs it does not know', () => {
    expect(parseLabs('{"automations": true, "teleport": true}')).toEqual({ automations: true });
  });
});
