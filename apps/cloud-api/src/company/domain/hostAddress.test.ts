import { describe, expect, it } from 'vitest';
import { hostAddressAllowed } from './hostAddress.js';

const deployed = { suffixes: ['e2b.app'], local: false };
const local = { suffixes: ['e2b.app'], local: true };

describe('hostAddressAllowed', () => {
  it.each(['https://7420-sbx-acme-1.e2b.app', 'https://a.b.e2b.app'])(
    'calls a host under an allowed suffix: %s',
    (hostUrl) => {
      expect(hostAddressAllowed(hostUrl, deployed)).toBe(true);
    },
  );

  it('calls a host under any of several suffixes', () => {
    const policy = { suffixes: ['e2b.app', 'sandboxes.sprocket.example'], local: false };
    expect(hostAddressAllowed('https://7420-one.sandboxes.sprocket.example', policy)).toBe(true);
  });

  it.each([
    ['the suffix itself', 'https://e2b.app'],
    ['a name that only ends like it', 'https://7420-sbx-acme-1.note2b.app'],
    ['the suffix inside another name', 'https://7420-sbx.e2b.app.attacker.example'],
    ['another host', 'https://metadata.internal.example'],
    ['an explicit port', 'https://7420-sbx-acme-1.e2b.app:8443'],
    ['plain http under the suffix', 'http://7420-sbx-acme-1.e2b.app'],
    ['a private IPv4 address', 'https://10.0.0.7'],
    ['a link-local address', 'https://169.254.169.254'],
    ['loopback over https', 'https://127.0.0.1'],
    ['an IPv6 address', 'https://[fd00::1]'],
    ['localhost over https', 'https://localhost'],
    ['a path', 'https://7420-sbx-acme-1.e2b.app/agent-run/follow-ups'],
    ['user info', 'https://person@7420-sbx-acme-1.e2b.app'],
    ['a socket address', 'wss://7420-sbx-acme-1.e2b.app'],
    ['a name not written as its origin', 'https://7420-SBX-acme-1.E2B.app'],
    ['no address', 'not a url'],
  ])('refuses %s', (_, hostUrl) => {
    expect(hostAddressAllowed(hostUrl, deployed)).toBe(false);
    expect(hostAddressAllowed(hostUrl, local)).toBe(false);
  });

  it.each(['http://127.0.0.1:41234', 'http://localhost:41234', 'http://[::1]:41234'])(
    'calls loopback over http only with local sandboxes: %s',
    (hostUrl) => {
      expect(hostAddressAllowed(hostUrl, local)).toBe(true);
      expect(hostAddressAllowed(hostUrl, deployed)).toBe(false);
    },
  );

  it.each([
    ['a private address', 'http://10.0.0.7:7420'],
    ['another loopback address', 'http://127.0.0.2:7420'],
    ['a number for loopback', 'http://2130706433:7420'],
    ['a name for another machine', 'http://sandbox.sprocket.example:7420'],
  ])('refuses %s over http, even with local sandboxes', (_, hostUrl) => {
    expect(hostAddressAllowed(hostUrl, local)).toBe(false);
  });
});
