/** Keep E2E launches off the desktop unless explicitly debugging visibly. */
export const isBackgroundTest =
  process.env.NODE_ENV === 'test' && process.env.CONSOLA_E2E_HEADED !== '1';

/**
 * Hands an object to the E2E suite, which reaches it from
 * `electronApp.evaluate` as `globalThis.__consolaTest[name]`. Only in a test
 * launch: anywhere else nothing is exposed, so no other code in main can come
 * to lean on it either.
 */
export function exposeToTests(name: string, value: unknown): void {
  if (process.env.NODE_ENV !== 'test') return;
  const root = globalThis as { __consolaTest?: Record<string, unknown> };
  root.__consolaTest ??= {};
  root.__consolaTest[name] = value;
}
