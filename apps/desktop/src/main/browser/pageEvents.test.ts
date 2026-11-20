import { describe, expect, it } from 'vitest';
import { MAX_ENTRY_CHARS, readPageEvent } from './pageEvents';
import { MB, retainedBy } from './retainedHeap.test-support';

const NOW = 1_700_000_000_000;

describe('readPageEvent', () => {
  describe('console calls', () => {
    it('reads console.error as a console error, its arguments joined', () => {
      const event = readPageEvent(
        'Runtime.consoleAPICalled',
        {
          type: 'error',
          args: [
            { type: 'string', value: 'Failed to render' },
            { type: 'number', value: 42 },
            { type: 'object', subtype: 'null', value: null },
            { type: 'undefined' },
            { type: 'number', unserializableValue: 'NaN' },
            { type: 'object', className: 'Object', description: 'Object' },
          ],
          timestamp: NOW - 5,
          stackTrace: {
            callFrames: [{ url: 'http://127.0.0.1:3000/app.js', lineNumber: 9, columnNumber: 4 }],
          },
        },
        NOW,
      );
      expect(event).toEqual({
        kind: 'console-error',
        entry: {
          text: 'Failed to render 42 null undefined NaN Object',
          source: 'http://127.0.0.1:3000/app.js:10',
          at: NOW - 5,
        },
      });
    });

    it('reads a failed console.assert, saying so', () => {
      const event = readPageEvent(
        'Runtime.consoleAPICalled',
        { type: 'assert', args: [{ type: 'string', value: 'cart is empty' }], timestamp: NOW },
        NOW,
      );
      expect(event).toEqual({
        kind: 'console-error',
        entry: { text: 'Assertion failed: cart is empty', at: NOW },
      });
    });

    it('ignores every other kind of console call', () => {
      for (const type of ['log', 'info', 'warning', 'debug', 'table', 'trace']) {
        expect(
          readPageEvent(
            'Runtime.consoleAPICalled',
            { type, args: [{ type: 'string', value: 'x' }], timestamp: NOW },
            NOW,
          ),
        ).toBeNull();
      }
    });
  });

  describe('uncaught exceptions', () => {
    it('reads one as a console error with its description', () => {
      const event = readPageEvent(
        'Runtime.exceptionThrown',
        {
          timestamp: NOW - 1,
          exceptionDetails: {
            text: 'Uncaught',
            url: 'http://127.0.0.1:3000/app.js',
            lineNumber: 0,
            exception: {
              type: 'object',
              subtype: 'error',
              description: "TypeError: Cannot read properties of undefined (reading 'x')",
            },
          },
        },
        NOW,
      );
      expect(event).toEqual({
        kind: 'console-error',
        entry: {
          text: "Uncaught TypeError: Cannot read properties of undefined (reading 'x')",
          source: 'http://127.0.0.1:3000/app.js:1',
          at: NOW - 1,
        },
      });
    });

    it('reads a rejected promise with a plain value', () => {
      const event = readPageEvent(
        'Runtime.exceptionThrown',
        {
          timestamp: NOW,
          exceptionDetails: {
            text: 'Uncaught (in promise)',
            exception: { type: 'string', value: 'nope' },
          },
        },
        NOW,
      );
      expect(event).toEqual({
        kind: 'console-error',
        entry: { text: 'Uncaught (in promise) nope', at: NOW },
      });
    });
  });

  describe("the browser's own log", () => {
    it('reads a network error as a failed request, with the address that failed', () => {
      const event = readPageEvent(
        'Log.entryAdded',
        {
          entry: {
            source: 'network',
            level: 'error',
            text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
            url: 'http://127.0.0.1:3000/missing.png',
            timestamp: NOW - 2,
            networkRequestId: '12.3',
          },
        },
        NOW,
      );
      expect(event).toEqual({
        kind: 'failed-request',
        entry: {
          url: 'http://127.0.0.1:3000/missing.png',
          reason: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
          at: NOW - 2,
        },
      });
    });

    it('reads any other error it logs as a console error', () => {
      const event = readPageEvent(
        'Log.entryAdded',
        {
          entry: {
            source: 'security',
            level: 'error',
            text: 'Refused to load the script because it violates the Content Security Policy',
            url: 'http://127.0.0.1:3000/',
            lineNumber: 3,
            timestamp: NOW,
          },
        },
        NOW,
      );
      expect(event).toEqual({
        kind: 'console-error',
        entry: {
          text: 'Refused to load the script because it violates the Content Security Policy',
          source: 'http://127.0.0.1:3000/:4',
          at: NOW,
        },
      });
    });

    it('ignores what it logs below error level', () => {
      for (const level of ['verbose', 'info', 'warning']) {
        expect(
          readPageEvent(
            'Log.entryAdded',
            { entry: { source: 'network', level, text: 'x', url: 'http://a/', timestamp: NOW } },
            NOW,
          ),
        ).toBeNull();
      }
    });
  });

  it('caps what one entry may hold, however much the page wrote', () => {
    const huge = 'x'.repeat(MAX_ENTRY_CHARS * 50);
    const consoleError = readPageEvent(
      'Runtime.consoleAPICalled',
      {
        type: 'error',
        args: [{ type: 'string', value: huge }],
        timestamp: NOW,
        stackTrace: { callFrames: [{ url: `data:text/javascript,${huge}`, lineNumber: 0 }] },
      },
      NOW,
    );
    expect(consoleError?.kind).toBe('console-error');
    if (consoleError?.kind !== 'console-error') return;
    expect(consoleError.entry.text.length).toBe(MAX_ENTRY_CHARS);
    expect(consoleError.entry.text.endsWith('…')).toBe(true);
    expect(consoleError.entry.source?.length).toBeLessThanOrEqual(MAX_ENTRY_CHARS);

    const failed = readPageEvent(
      'Log.entryAdded',
      {
        entry: {
          source: 'network',
          level: 'error',
          text: huge,
          url: `data:image/png;base64,${huge}`,
          timestamp: NOW,
        },
      },
      NOW,
    );
    if (failed?.kind !== 'failed-request') throw new Error('expected a failed request');
    expect(failed.entry.url.length).toBe(MAX_ENTRY_CHARS);
    expect(failed.entry.reason.length).toBe(MAX_ENTRY_CHARS);
  });

  it('keeps a copy of what it cuts, never the whole of what the page logged', () => {
    // Each entry would otherwise hold its whole 5 MB message, its address and its source.
    const consoleErrors = retainedBy((text) =>
      readPageEvent(
        'Runtime.consoleAPICalled',
        {
          type: 'error',
          args: [{ type: 'string', value: text }],
          timestamp: NOW,
          stackTrace: { callFrames: [{ url: text, lineNumber: 0 }] },
        },
        NOW,
      ),
    );
    expect(consoleErrors).toBeLessThan(10 * MB);
    const exceptions = retainedBy((text) =>
      readPageEvent(
        'Runtime.exceptionThrown',
        { exceptionDetails: { text, url: text, exception: { description: text } } },
        NOW,
      ),
    );
    expect(exceptions).toBeLessThan(10 * MB);
    const failedRequests = retainedBy((text) =>
      readPageEvent(
        'Log.entryAdded',
        { entry: { source: 'network', level: 'error', text, url: text, timestamp: NOW } },
        NOW,
      ),
    );
    expect(failedRequests).toBeLessThan(10 * MB);
  });

  it('takes the time it was read for an entry the page did not date', () => {
    const event = readPageEvent(
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ type: 'string', value: 'undated' }] },
      NOW,
    );
    expect(event).toEqual({ kind: 'console-error', entry: { text: 'undated', at: NOW } });
  });

  it('ignores other events and anything malformed', () => {
    expect(readPageEvent('Network.loadingFailed', { requestId: '1' }, NOW)).toBeNull();
    expect(readPageEvent('Runtime.consoleAPICalled', null, NOW)).toBeNull();
    expect(readPageEvent('Runtime.consoleAPICalled', { type: 'error', args: 'no' }, NOW)).toEqual({
      kind: 'console-error',
      entry: { text: '', at: NOW },
    });
    expect(readPageEvent('Runtime.exceptionThrown', {}, NOW)).toBeNull();
    expect(readPageEvent('Log.entryAdded', { entry: 'no' }, NOW)).toBeNull();
    expect(readPageEvent('Log.entryAdded', undefined, NOW)).toBeNull();
  });
});
