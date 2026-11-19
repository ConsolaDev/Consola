import { describe, expect, it } from 'vitest';
import {
  browserPartitionFor,
  isAllowedPageUrl,
  isLoopbackHost,
  resolveAddressInput,
  routeTerminalLink,
} from './browser';

describe('browserPartitionFor', () => {
  it('names one persistent partition per workspace', () => {
    expect(browserPartitionFor('w1')).toBe('persist:consola-browser-w1');
  });
});

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.9.8.7',
    '::1',
    '[::1]',
    '0.0.0.0',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', '128.0.0.1', '127.0.0.256', '192.168.1.1', ''])(
    'does not treat %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('isAllowedPageUrl', () => {
  it('allows only parseable http and https URLs', () => {
    expect(isAllowedPageUrl('http://localhost:3000/')).toBe(true);
    expect(isAllowedPageUrl('https://example.com')).toBe(true);
    expect(isAllowedPageUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedPageUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedPageUrl('data:text/html,hi')).toBe(false);
    expect(isAllowedPageUrl('about:blank')).toBe(false);
    expect(isAllowedPageUrl('chrome://settings')).toBe(false);
    expect(isAllowedPageUrl('devtools://devtools/x')).toBe(false);
    expect(isAllowedPageUrl('not a url')).toBe(false);
    expect(isAllowedPageUrl('')).toBe(false);
  });
});

describe('resolveAddressInput', () => {
  it('opens localhost over http, as typed', () => {
    expect(resolveAddressInput('localhost:3000')).toEqual({
      kind: 'url',
      url: 'http://localhost:3000/',
    });
  });

  it('defaults a dotted host to https', () => {
    expect(resolveAddressInput('example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com/',
    });
  });

  it('opens an IP with a port and path over http', () => {
    expect(resolveAddressInput('127.0.0.1:8080/x')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8080/x',
    });
  });

  it('opens a bracketed IPv6 loopback with a port', () => {
    expect(resolveAddressInput('[::1]:5173')).toEqual({
      kind: 'url',
      url: 'http://[::1]:5173/',
    });
  });

  it('opens a non-loopback host:port over https', () => {
    expect(resolveAddressInput('myhost:8443')).toEqual({
      kind: 'url',
      url: 'https://myhost:8443/',
    });
  });

  it('keeps an explicit scheme, whatever its case', () => {
    expect(resolveAddressInput('HTTPS://Example.com')).toEqual({
      kind: 'url',
      url: 'https://example.com/',
    });
    expect(resolveAddressInput('http://example.com/a?b=1')).toEqual({
      kind: 'url',
      url: 'http://example.com/a?b=1',
    });
  });

  it('trims the input', () => {
    expect(resolveAddressInput('  example.com  ')).toEqual({
      kind: 'url',
      url: 'https://example.com/',
    });
  });

  it('searches DuckDuckGo for words with a space', () => {
    expect(resolveAddressInput('foo bar')).toEqual({
      kind: 'search',
      url: 'https://duckduckgo.com/?q=foo%20bar',
    });
  });

  it('searches for a single word with no dot and no colon', () => {
    expect(resolveAddressInput('foo')).toEqual({
      kind: 'search',
      url: 'https://duckduckgo.com/?q=foo',
    });
  });

  it('searches for text that merely contains an address', () => {
    expect(resolveAddressInput('what is example.com')).toMatchObject({
      kind: 'search',
    });
  });

  it('rejects every other scheme', () => {
    for (const input of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://settings',
      'about:blank',
      'about:srcdoc',
      'ftp://example.com',
      'mailto:a@b.c',
    ]) {
      expect(resolveAddressInput(input)).toMatchObject({ kind: 'rejected' });
    }
  });

  it('rejects empty input', () => {
    expect(resolveAddressInput('')).toMatchObject({ kind: 'rejected' });
    expect(resolveAddressInput('   ')).toMatchObject({ kind: 'rejected' });
  });
});

describe('routeTerminalLink', () => {
  const local = 'http://localhost:3000/';
  const remote = 'https://example.com/';

  it('local: loopback goes to Consola, the rest to the system', () => {
    expect(routeTerminalLink(local, 'local', false)).toBe('consola');
    expect(routeTerminalLink(remote, 'local', false)).toBe('system');
  });

  it('all: every web link goes to Consola', () => {
    expect(routeTerminalLink(local, 'all', false)).toBe('consola');
    expect(routeTerminalLink(remote, 'all', false)).toBe('consola');
  });

  it('never: everything goes to the system', () => {
    expect(routeTerminalLink(local, 'never', false)).toBe('system');
    expect(routeTerminalLink(remote, 'never', false)).toBe('system');
  });

  it('Shift inverts the result once', () => {
    expect(routeTerminalLink(local, 'local', true)).toBe('system');
    expect(routeTerminalLink(remote, 'local', true)).toBe('consola');
    expect(routeTerminalLink(local, 'all', true)).toBe('system');
    expect(routeTerminalLink(remote, 'all', true)).toBe('system');
    expect(routeTerminalLink(local, 'never', true)).toBe('consola');
    expect(routeTerminalLink(remote, 'never', true)).toBe('consola');
  });

  it('never sends a non-web link into a page', () => {
    for (const rule of ['local', 'all', 'never'] as const) {
      for (const shift of [false, true]) {
        expect(routeTerminalLink('file:///etc/passwd', rule, shift)).toBe('system');
        expect(routeTerminalLink('not a url', rule, shift)).toBe('system');
      }
    }
  });
});
