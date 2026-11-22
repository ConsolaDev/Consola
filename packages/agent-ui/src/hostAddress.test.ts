import { describe, expect, it } from 'vite-plus/test';
import { hostHttpOrigin } from './hostAddress.ts';

describe('hostHttpOrigin', () => {
  it.each([
    ['http://127.0.0.1:7420', 'http://127.0.0.1:7420'],
    ['https://host.sprocket.example', 'https://host.sprocket.example'],
    ['ws://127.0.0.1:7420', 'http://127.0.0.1:7420'],
    ['WS://127.0.0.1:7420/ws', 'http://127.0.0.1:7420'],
    ['wss://host.sprocket.example:8443/ws?x=1', 'https://host.sprocket.example:8443'],
  ])('reads %s as %s', (given, origin) => {
    expect(hostHttpOrigin(given)).toBe(origin);
  });

  it('throws on an address that is not a URL', () => {
    expect(() => hostHttpOrigin('not an address')).toThrow();
  });
});
