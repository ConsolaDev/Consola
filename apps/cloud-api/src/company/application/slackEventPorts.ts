// What Slack's events and the requests they start need from the world outside, beside what
// `slackPorts.ts` declares: the check of Slack's signatures, and a way to run work after the
// answer.

/** A request as Slack signed it: the body's bytes and the two headers that sign it. */
export type SignedSlackRequest = {
  /** The body exactly as it arrived: the signature is over these bytes. */
  body: Uint8Array;
  /** `X-Slack-Request-Timestamp`: whole seconds since the epoch, as Slack wrote them. */
  timestamp: string | undefined;
  /** `X-Slack-Signature`: `v0=` and the signature in hex. */
  signature: string | undefined;
};

/**
 * What checking a request's signature found: Slack's (`valid`); a timestamp missing, unreadable
 * or more than five minutes from now (`stale`); or no signature of Slack's over this body under
 * the secret (`mismatch`).
 */
export type SignatureCheck = 'valid' | 'stale' | 'mismatch';

/** Checks Slack's signatures, each under the signing secret of the factory's app it is handed. */
export type SlackSignatures = {
  verify(signingSecret: string, request: SignedSlackRequest, nowSeconds: number): SignatureCheck;
};
