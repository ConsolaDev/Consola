/**
 * What crosses between the renderer and main for Settings › Secrets: names,
 * references and words, never a value. Main builds and checks the reference
 * (`main/secrets/references.ts`); the renderer only collects its fields.
 */

/** The Bind dialog's fields: one of the three places a value can live on this Mac. */
export type SecretReferenceInput =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: '1password'; reference: string }
  | { kind: 'env'; name: string };
