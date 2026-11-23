import type { RunnerChannel } from '../../application/ports.js';

/**
 * The channel of a cell with no runner socket: no runner is ever connected, so no session starts,
 * and nothing is ever sent.
 */
export const noRunner: RunnerChannel = {
  connected: () => null,
  startSession: () => Promise.reject(new Error('no runner is connected')),
  stopSession: () => Promise.reject(new Error('no runner is connected')),
};
