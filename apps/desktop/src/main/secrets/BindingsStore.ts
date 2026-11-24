import { secretNameProblem } from '@consola/factory-spec';
import type { JsonStateFile } from '../state/JsonStateFile';
import { type BindingRef, formatReference, parseReference } from './references';

/**
 * Where this Mac keeps each secret name's binding: `secret-bindings.json` in
 * the app's data folder, per workspace and per factory, references and the
 * path of `op` only, never a value. Main is its only writer. A file it could
 * not read makes every name read as unbound and is never written over (review
 * S5): `JsonStateFile.write` backs up only a readable primary, so a write
 * would lose the person's hand edit for good.
 */

/** One binding as the file holds it. */
export interface StoredBinding {
  /** The reference's text (`formatReference`). */
  ref: string;
  /** Where `op` was when the person bound a 1Password reference. */
  op?: string;
  /** ISO time of the last bind: the tab's "last changed". */
  boundAt: string;
}

export interface SecretBindingsFile {
  version: 1;
  workspaces: Record<string, { factories: Record<string, Record<string, StoredBinding>> }>;
}

/** A stored binding whose reference parses. */
export interface Binding {
  ref: BindingRef;
  op?: string;
  boundAt: string;
}

type Factories = Record<string, Record<string, StoredBinding>>;
type Workspaces = Record<string, { factories: Factories }>;

/** The tab's words for a file that did not read (Call 15). */
export function bindingsFileProblem(reason: string): string {
  return `Consola couldn't read secret-bindings.json (${reason}), so no secret reads as bound; fix or remove the file, then reopen this tab.`;
}

const NOT_JSON = "it isn't readable JSON";
const NOT_BINDINGS = "it isn't a version 1 bindings file";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `record[key]` when the record holds it itself: `constructor` or `__proto__` are never a workspace, factory or name. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Entries with the keys a plain object would treat as its own machinery left out. */
const entriesOf = (record: Record<string, unknown>) =>
  Object.entries(record).filter(([key]) => key !== '__proto__');

/**
 * The file's bindings as this store's own model: only `ref`, `op` and
 * `boundAt` of each, so a field written by hand (a `value`) is never read and
 * is gone at the next write. An entry it cannot read as a binding is left
 * out, and reads as unbound.
 */
function modelOf(raw: unknown): Workspaces | null {
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.workspaces)) return null;
  const workspaces: Workspaces = {};
  for (const [workspaceId, workspace] of entriesOf(raw.workspaces)) {
    if (!isRecord(workspace) || !isRecord(workspace.factories)) continue;
    const factories: Factories = {};
    for (const [factory, names] of entriesOf(workspace.factories)) {
      if (!isRecord(names)) continue;
      const bindings: Record<string, StoredBinding> = {};
      for (const [name, stored] of entriesOf(names)) {
        if (!isRecord(stored) || typeof stored.ref !== 'string') continue;
        if (typeof stored.boundAt !== 'string') continue;
        bindings[name] = {
          ref: stored.ref,
          ...(typeof stored.op === 'string' ? { op: stored.op } : {}),
          boundAt: stored.boundAt,
        };
      }
      if (Object.keys(bindings).length > 0) factories[factory] = bindings;
    }
    if (Object.keys(factories).length > 0) workspaces[workspaceId] = { factories };
  }
  return workspaces;
}

export class BindingsStore {
  private workspaces: Workspaces = {};
  private readProblem: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly file: JsonStateFile<SecretBindingsFile>,
    private readonly now: () => Date,
  ) {
    this.load();
  }

  /** Why the file did not read (Call 15), or null. */
  public get problem(): string | null {
    return this.readProblem;
  }

  /** The stored names whose reference parses, sorted. */
  public names(workspaceId: string, factory: string): string[] {
    const bindings = this.bindingsOf(this.workspaces, workspaceId, factory) ?? {};
    return Object.keys(bindings)
      .filter((name) => parseReference(bindings[name].ref).ok)
      .sort();
  }

  /** A stored binding whose `ref` does not parse reads as null. */
  public get(workspaceId: string, factory: string, name: string): Binding | null {
    const stored = own(this.bindingsOf(this.workspaces, workspaceId, factory), name);
    if (!stored) return null;
    const parsed = parseReference(stored.ref);
    if (!parsed.ok) return null;
    return {
      ref: parsed.ref,
      ...(stored.op !== undefined ? { op: stored.op } : {}),
      boundAt: stored.boundAt,
    };
  }

  /** Binds `name` to `ref`, a rebind included; throws `problem` when the file did not read. */
  public bind(
    workspaceId: string,
    factory: string,
    name: string,
    ref: BindingRef,
    op?: string,
  ): void {
    this.assertReadable();
    const nameProblem = secretNameProblem(name);
    if (nameProblem) throw new Error(nameProblem);
    const text = formatReference(ref);
    const parsed = parseReference(text);
    if (!parsed.ok) throw new Error(parsed.problem);
    const next = this.copy();
    const workspace = own(next, workspaceId) ?? { factories: {} };
    const bindings = own(workspace.factories, factory) ?? {};
    bindings[name] = {
      ref: text,
      ...(op !== undefined ? { op } : {}),
      boundAt: this.now().toISOString(),
    };
    workspace.factories[factory] = bindings;
    next[workspaceId] = workspace;
    this.commit(next);
  }

  /** Removes `name`'s binding; throws `problem` when the file did not read, its bytes unchanged (review S5). */
  public unbind(workspaceId: string, factory: string, name: string): void {
    this.assertReadable();
    if (!own(this.bindingsOf(this.workspaces, workspaceId, factory), name)) return;
    const next = this.copy();
    const factories = next[workspaceId].factories;
    delete factories[factory][name];
    if (Object.keys(factories[factory]).length === 0) delete factories[factory];
    if (Object.keys(factories).length === 0) delete next[workspaceId];
    this.commit(next);
  }

  /**
   * Removes the bindings of every workspace not in `ids` (Call 14). A no-op
   * while `problem` is set, and it writes only when it removed something: it
   * runs on every workspace write (review S5).
   */
  public keepWorkspaces(ids: ReadonlySet<string>): void {
    if (this.readProblem !== null) return;
    const gone = Object.keys(this.workspaces).filter((id) => !ids.has(id));
    if (gone.length === 0) return;
    const next = this.copy();
    for (const id of gone) delete next[id];
    this.commit(next);
  }

  /**
   * While `problem` is set, reads the file again: true when it now reads (the
   * problem cleared, its bindings loaded, `onChange` fired). False, reading
   * nothing, when there is no problem; false, the bytes unchanged, when it
   * still does not read (review S4).
   */
  public retry(): boolean {
    if (this.readProblem === null) return false;
    this.load();
    if (this.readProblem !== null) return false;
    this.emit();
    return true;
  }

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private bindingsOf(
    workspaces: Workspaces,
    workspaceId: string,
    factory: string,
  ): Record<string, StoredBinding> | undefined {
    return own(own(workspaces, workspaceId)?.factories, factory);
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = this.file.read();
    } catch {
      this.fail(NOT_JSON);
      return;
    }
    if (raw === null) {
      this.workspaces = {};
      this.readProblem = null;
      return;
    }
    const model = modelOf(raw);
    if (!model) {
      this.fail(NOT_BINDINGS);
      return;
    }
    this.workspaces = model;
    this.readProblem = null;
  }

  private fail(reason: string): void {
    this.workspaces = {};
    this.readProblem = bindingsFileProblem(reason);
  }

  private assertReadable(): void {
    if (this.readProblem !== null) throw new Error(this.readProblem);
  }

  private copy(): Workspaces {
    return JSON.parse(JSON.stringify(this.workspaces)) as Workspaces;
  }

  /** Writes `next` and only then makes it the store's: a write that throws changes nothing. */
  private commit(next: Workspaces): void {
    this.file.write({ version: 1, workspaces: next });
    this.workspaces = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
