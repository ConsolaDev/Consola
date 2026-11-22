/**
 * The E2B provider: `new E2BProvider({ apiKey })`, handed to `sandboxesFrom`. It is an entry
 * point of its own, so code that only needs the interface, or the fake, never loads E2B's SDK.
 */
export { E2BProvider, type E2BProviderOptions } from './providers/e2b/E2BProvider';
