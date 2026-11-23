/**
 * t3's connection runtime as `AgentChat` uses it: its services, an effect run against them, and
 * the stores where t3 keeps what it knows of a host (`src/storedSessions.ts` clears them).
 */
import {
  BearerConnectionCredential,
  CredentialStore,
  type EnvironmentRegistry,
} from '@t3tools/client-runtime/connection';
import { Persistence } from '@t3tools/client-runtime/platform';
import { EnvironmentId } from '@t3tools/contracts';
import * as Cause from 'effect/Cause';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import type * as Exit from 'effect/Exit';
import { connectionAtomRuntime } from '~/connection/runtime';
import { appAtomRegistry } from '~/rpc/atomRegistry';

/** What `AgentChat` uses of the runtime's services: its registry and its stores. */
export type ConnectionServices =
  | EnvironmentRegistry.EnvironmentRegistry
  | CredentialStore.ConnectionCredentialStore
  | Persistence.EnvironmentCacheStore;

/** The connection runtime's services, once t3's runtime has built them. */
export const connectionServices = (): Promise<Context.Context<ConnectionServices>> =>
  new Promise((resolve, reject) => {
    const unsubscribe = appAtomRegistry.subscribe(
      connectionAtomRuntime,
      (result) => {
        if (result._tag === 'Success') {
          queueMicrotask(() => unsubscribe());
          resolve(result.value as Context.Context<ConnectionServices>);
        } else if (result._tag === 'Failure') {
          queueMicrotask(() => unsubscribe());
          reject(Cause.squash(result.cause));
        }
      },
      { immediate: true },
    );
  });

export const runInConnection = <A, E>(
  effect: Effect.Effect<A, E, ConnectionServices>,
): Promise<Exit.Exit<A, E>> =>
  connectionServices().then((services) =>
    Effect.runPromiseExit(Effect.provideContext(effect, services)),
  );

/** The connection id of a host's registration, under which t3 keeps its pass. */
export const connectionIdFor = (sessionId: string) => `consola-host:${sessionId}`;

/**
 * Deletes what t3 keeps for a session's host after its registration is gone, as t3 does when it
 * removes a platform registration (`EnvironmentRegistry` `removePlatformEnvironment`): the pass
 * (its credential store), the cached thread and the rest of the environment's cache, and the
 * data other modules keep per environment.
 */
export const forgetStoredSession = Effect.fn('forgetStoredSession')(function* (sessionId: string) {
  const environmentId = EnvironmentId.make(sessionId);
  const credentials = yield* CredentialStore.ConnectionCredentialStore;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const ownedData = yield* Persistence.EnvironmentOwnedDataCleanup;
  yield* credentials.remove(connectionIdFor(sessionId));
  yield* cache.clear(environmentId);
  yield* ownedData.clear(environmentId);
});

/**
 * Puts a session's pass back in t3's credential store. t3 deletes it when a registration is
 * removed, and another window that still shows the session needs it (`AgentChat.tsx`).
 */
export const restoreStoredPass = Effect.fn('restoreStoredPass')(function* (
  sessionId: string,
  token: string,
) {
  const credentials = yield* CredentialStore.ConnectionCredentialStore;
  yield* credentials.put(connectionIdFor(sessionId), new BearerConnectionCredential({ token }));
});
