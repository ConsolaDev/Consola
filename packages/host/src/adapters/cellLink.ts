// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The ring is plain promises: a request's id is node:crypto's, its deadline a timer.
/**
 * The automations ring's link to its cell (`core/automations/ports.ts`, `CellLink`), over the
 * runner's socket (`cellSocket.ts`).
 *
 * - **Records and acknowledgements** go at once if a socket is greeted, and are not queued: the
 *   ring says every run's latest record again when the next socket is greeted.
 * - **Requests** (the factories, a step's token) carry a `requestId` of their own and wait for the
 *   cell's answer naming it, `REQUEST_TIMEOUT_MS` at most. One asked while the socket is down, or
 *   whose socket dropped before the answer came, is asked again on each socket greeted until it is
 *   answered or its time is up, so a reconnect loses no request. An answer naming no request this
 *   link holds (one that timed out, or another process's) is logged and dropped.
 * - A token is a secret: it is handed to the ring and never logged.
 */
import { randomUUID } from 'node:crypto';
import type {
  FactoriesAnswer,
  FactoriesRequest,
  FactoryPick,
  FactorySnapshot,
  GitHubStepToken,
  GitHubStepTokenRefused,
  GitHubStepTokenRequest,
} from '@consola/runner-protocol';
import type { CellLink, TokenAnswer, TokenRequest } from '../core/automations/ports.ts';
import type { RunMessage } from './cellSocket.ts';

/** How long the ring waits for the cell to answer a request. */
export const REQUEST_TIMEOUT_MS = 30_000;

type Pending =
  | {
      readonly message: FactoriesRequest;
      readonly resolve: (factories: readonly FactorySnapshot[]) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | {
      readonly message: GitHubStepTokenRequest;
      readonly resolve: (answer: TokenAnswer) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    };

export type CellLinkAdapter = CellLink & {
  /** The cell's answer to a request. */
  readonly answer: (message: FactoriesAnswer | GitHubStepToken | GitHubStepTokenRefused) => void;
  /** A socket was greeted: every request still waiting is asked on it. */
  readonly connected: () => void;
  /** The runner is stopping: every request still waiting fails, saying so. */
  readonly close: () => void;
};

export type CellLinkOptions = {
  /** Says a message on the greeted socket now: false when there is none (`CellSocket.sendNow`). */
  readonly sendNow: (message: RunMessage) => boolean;
  readonly log: (line: string) => void;
  /** How long a request may wait (`REQUEST_TIMEOUT_MS` unless a test shortens it). */
  readonly timeoutMs?: number;
  /** A request's id (`randomUUID` unless a test names its own). */
  readonly requestId?: () => string;
};

export function makeCellLink(options: CellLinkOptions): CellLinkAdapter {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const nextId = options.requestId ?? randomUUID;
  const pending = new Map<string, Pending>();
  let closed = false;

  const expire = (requestId: string) => () => {
    const waiting = pending.get(requestId);
    if (waiting === undefined) return;
    pending.delete(requestId);
    waiting.reject(new Error(`The cell did not answer within ${Math.round(timeoutMs / 1000)} s.`));
  };

  return {
    send: (message) => options.sendNow(message),
    factories: (only?: FactoryPick) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error('The runner is stopping.'));
        const requestId = nextId();
        const message: FactoriesRequest = {
          type: 'factories.request',
          requestId,
          ...(only !== undefined ? { only: { ...only } } : {}),
        };
        pending.set(requestId, {
          message,
          resolve,
          reject,
          timer: setTimeout(expire(requestId), timeoutMs),
        });
        options.sendNow(message);
      }),
    token: (request: TokenRequest) =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error('The runner is stopping.'));
        const requestId = nextId();
        const message: GitHubStepTokenRequest = {
          type: 'github.token.request',
          requestId,
          runId: request.runId,
          stepId: request.stepId,
          repository: request.repository,
          permissions: { ...request.permissions },
        };
        pending.set(requestId, {
          message,
          resolve,
          reject,
          timer: setTimeout(expire(requestId), timeoutMs),
        });
        options.sendNow(message);
      }),
    answer: (message) => {
      const waiting = pending.get(message.requestId);
      if (waiting === undefined) {
        options.log(
          `the cell answered request ${message.requestId}, which this runner is not waiting on; dropped`,
        );
        return;
      }
      pending.delete(message.requestId);
      clearTimeout(waiting.timer);
      if (waiting.message.type === 'factories.request') {
        if (message.type === 'factories') {
          (waiting.resolve as (factories: readonly FactorySnapshot[]) => void)(message.factories);
        } else waiting.reject(new Error('The cell answered a factories request with a token.'));
        return;
      }
      const resolve = waiting.resolve as (answer: TokenAnswer) => void;
      if (message.type === 'github.token') resolve({ ok: true, token: message.token });
      else if (message.type === 'github.token.refused')
        resolve({ ok: false, reason: message.reason });
      else waiting.reject(new Error('The cell answered a token request with factories.'));
    },
    connected: () => {
      for (const waiting of pending.values()) options.sendNow(waiting.message);
    },
    close: () => {
      closed = true;
      for (const [requestId, waiting] of pending) {
        clearTimeout(waiting.timer);
        pending.delete(requestId);
        waiting.reject(new Error('The runner is stopping.'));
      }
    },
  };
}
