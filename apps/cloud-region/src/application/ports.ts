// What the use cases need from the world outside, each implemented by an adapter.

export type HealthProbe = {
  /** Whether the database answers a query, never throwing when it does not. */
  databaseAnswers(): Promise<boolean>;
};

/** What checking a token's signature found. */
export type SignatureCheck =
  /** Signed by one of `cloud-global`'s keys, for a cell, and in date: its claims, still unread. */
  | { kind: 'verified'; payload: unknown }
  /** Not a token `cloud-global` signed for a cell, or no longer in date. */
  | { kind: 'invalid' }
  /** `cloud-global`'s keys could not be had, so no token can be checked. */
  | { kind: 'keys-unavailable' };

export type TokenVerifier = {
  /**
   * Checks a cell token at `nowSeconds` (whole seconds since the epoch): its signature with
   * `cloud-global`'s public keys, allowing `CELL_TOKEN_ALGORITHM` alone, and its audience and
   * times as the contract has them. It never throws, and never lets a token through when the keys
   * cannot be had.
   */
  verify(token: string, nowSeconds: number): Promise<SignatureCheck>;
};

export type Clock = {
  /** The time now, in whole seconds since the epoch. */
  nowSeconds(): number;
};
