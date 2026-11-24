import { createHash } from 'node:crypto';
import {
  describeError,
  PERSONAL_FACTORY,
  type SecretBinding,
  SecretReadError,
  SecretReaderFailure,
  type SecretsPort,
  type readKeychainItem,
  type readOnePasswordField,
} from '@consola/automation-engine';
import type { SecretReferenceInput } from '../../shared/secrets';
import type { BindingsStore } from './BindingsStore';
import type { SecretPrograms } from './programs';
import {
  type BindingRef,
  formatReference,
  REFERENCE_WORDS,
  referenceFromInput,
  referenceLabel,
} from './references';

/**
 * The desktop's secrets: the engine's `SecretsPort` over `secret-bindings.json`
 * (`BindingsStore`) and the two readers. A value is read only when the engine
 * asks (`resolve`), by the program `programs` names, and goes back to the
 * engine alone: nothing here logs one, keeps one or sends one to a window.
 */

export interface DesktopSecretsDeps {
  store: BindingsStore;
  /** Required, with no default (rule 5a-secrets): `secretPrograms()` is the one place real programs are named. */
  programs: SecretPrograms;
  /** The login environment once its retry settled: `await loginEnvRetry()`, then a copy of `getLoginEnv()`. */
  loginEnv(): Promise<NodeJS.ProcessEnv>;
  readKeychain: typeof readKeychainItem;
  readOnePassword: typeof readOnePasswordField;
}

export const DESKTOP_BIND_HINT = 'on this Mac (Settings › Secrets)';

/** Why `bindSecret` refuses a 1Password reference: there is no `op` to read it with. */
export const OP_MISSING_WORDS =
  "`op` (1Password's CLI) isn't on your login PATH; install it, then bind again.";

/** A 1Password binding with no `op` kept, which only a hand edit of the file leaves. */
export const NO_OP_KEPT = "it was bound without `op`'s path; bind it again";

/** An opaque hash of a binding's reference: equal for equal references (Call 16). */
function fingerprintOf(ref: BindingRef): string {
  return createHash('sha256').update(formatReference(ref)).digest('hex').slice(0, 16);
}

export function desktopSecretsPort(deps: DesktopSecretsDeps): SecretsPort {
  const { store, programs } = deps;

  const readOne = async (workspaceId: string, factory: string, name: string): Promise<string> => {
    const binding = store.get(workspaceId, factory, name);
    if (!binding) throw new SecretReadError(name, `it is not bound ${DESKTOP_BIND_HINT}`);
    const { ref } = binding;
    try {
      switch (ref.kind) {
        case 'keychain': {
          const program = programs.keychain;
          if (!program) throw new SecretReadError(name, 'a test run reads no keychain');
          return await deps.readKeychain({
            program,
            env: await deps.loginEnv(),
            service: ref.service,
            account: ref.account,
          });
        }
        case '1password': {
          const program = programs.onePassword(binding.op);
          if (!program)
            throw new SecretReadError(
              name,
              binding.op === undefined ? NO_OP_KEPT : 'a test run reads no 1Password',
            );
          return await deps.readOnePassword({
            program,
            env: await deps.loginEnv(),
            reference: ref.reference,
          });
        }
        case 'env': {
          // After the login environment's retry: a variable the boot-time probe missed is there by now, or never.
          const env = await deps.loginEnv();
          const value = Object.prototype.hasOwnProperty.call(env, ref.name)
            ? env[ref.name]
            : undefined;
          if (value === undefined)
            throw new SecretReadError(name, `your login environment has no \`${ref.name}\``);
          return value;
        }
      }
    } catch (error) {
      if (error instanceof SecretReadError) throw error;
      if (error instanceof SecretReaderFailure) throw new SecretReadError(name, error.reason);
      // Anything else (the login environment, say) failed this name's read too: it says so, not the first's (review M1).
      throw new SecretReadError(name, describeError(error).trim().replace(/\.$/, ''));
    }
  };

  return {
    bindHint: DESKTOP_BIND_HINT,
    boundNames: (workspaceId, factory) => new Set(store.names(workspaceId, factory)),
    describe: (workspaceId, factory, name): SecretBinding | null => {
      const binding = store.get(workspaceId, factory, name);
      if (!binding) return null;
      return {
        kind: binding.ref.kind,
        label: referenceLabel(binding.ref),
        changedAt: binding.boundAt,
        ...(binding.op !== undefined ? { program: binding.op } : {}),
      };
    },
    fingerprint: (workspaceId, factory, name) => {
      const binding = store.get(workspaceId, factory, name);
      return binding ? fingerprintOf(binding.ref) : null;
    },
    // One name after another: a keychain dialog for one is answered before the next asks.
    resolve: async (workspaceId, factory, names) => {
      const values: Record<string, string> = {};
      for (const name of names) values[name] = await readOne(workspaceId, factory, name);
      return values;
    },
  };
}

/**
 * Validates and stores one binding in the workspace's one factory; for
 * `op://`, finds `op` on the login `PATH` now (a file check, no spawn) and
 * keeps its path. Reads no value. Throws with the reference's own words.
 */
export async function bindSecret(
  deps: Pick<DesktopSecretsDeps, 'store' | 'programs' | 'loginEnv'>,
  workspaceId: string,
  name: string,
  input: SecretReferenceInput,
): Promise<void> {
  const parsed = referenceFromInput(input);
  if (!parsed.ok) throw new Error(parsed.problem);
  let op: string | undefined;
  if (parsed.ref.kind === '1password') {
    const found = deps.programs.findOnePassword((await deps.loginEnv()).PATH);
    if (!found) throw new Error(OP_MISSING_WORDS);
    op = found;
  }
  deps.store.bind(workspaceId, PERSONAL_FACTORY, name, parsed.ref, op);
}

/** A `secrets:bind` reference as the renderer sent it: one of the three shapes, its fields strings, or a throw. */
export function asSecretReferenceInput(value: unknown): SecretReferenceInput {
  const given = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string): string => {
    const field = given[key];
    if (typeof field !== 'string') throw new Error(REFERENCE_WORDS);
    return field;
  };
  switch (given.kind) {
    case 'keychain':
      return { kind: 'keychain', service: text('service'), account: text('account') };
    case '1password':
      return { kind: '1password', reference: text('reference') };
    case 'env':
      return { kind: 'env', name: text('name') };
    default:
      throw new Error(REFERENCE_WORDS);
  }
}
