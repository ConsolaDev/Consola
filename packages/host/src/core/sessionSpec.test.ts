import { describe, expect, it } from 'vite-plus/test';
import type { SessionSpec } from './sessionSpec.ts';

describe('SessionSpec', () => {
  it('names the session, its harness and where it runs', () => {
    const spec: SessionSpec = { sessionId: 's-1', harness: 'claude', cwd: '/work/sprocket' };
    expect(spec.harness).toBe('claude');
  });
});
