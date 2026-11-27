import type { Clock } from '../../application/ports.js';

/** The machine's clock, in whole seconds. */
export const systemClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};
