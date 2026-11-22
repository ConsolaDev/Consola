import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppliedFactory, AppliedFactoryStore } from '../ports';

const FILE = 'applied.json';
const VERSION = 1;

/** A folder's key: the first 16 hex of the sha256 of its path, resolved by the caller. */
function keyOf(resolved: string): string {
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The document as this version writes it, checked field by field; null for anything else. */
function parseApplied(raw: unknown, folder: string): AppliedFactory | null {
  if (!isRecord(raw)) return null;
  const { version, appliedAt, clean, texts } = raw;
  if (version !== VERSION) return null;
  if (raw.folder !== folder) return null;
  if (typeof appliedAt !== 'string' || typeof clean !== 'boolean' || !isRecord(texts)) return null;
  const kept: Record<string, string> = {};
  for (const key of Object.keys(texts)) {
    const text = texts[key];
    if (typeof text !== 'string') return null;
    kept[key] = text;
  }
  return { folder, appliedAt, clean, texts: kept };
}

/**
 * Each factory folder's last applied version, in Consola's own state folder:
 * `<root>/<key>/applied.json`, `<key>` from the folder's resolved path. Written
 * whole, through a temporary file renamed over it. A file that cannot be read,
 * or is not this shape, is logged and renamed aside (`applied.json.damaged-<time>`)
 * so nothing is lost silently, and reads as none: the folder then applies as
 * on its first start, which never runs anything a file does not say.
 */
export class AppliedFactoryFiles implements AppliedFactoryStore {
  constructor(private readonly root: string) {}

  public read(folder: string): AppliedFactory | null {
    const resolved = path.resolve(folder);
    const file = this.fileOf(resolved);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return this.damaged(file, resolved, `it could not be read (${(error as Error).message})`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.damaged(file, resolved, 'it is not JSON');
    }
    return (
      parseApplied(raw, resolved) ?? this.damaged(file, resolved, 'it is not an applied version')
    );
  }

  public write(applied: AppliedFactory): void {
    const folder = path.resolve(applied.folder);
    const file = this.fileOf(folder);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const document = {
      version: VERSION,
      folder,
      appliedAt: applied.appliedAt,
      clean: applied.clean,
      texts: applied.texts,
    };
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`);
    fs.renameSync(temporary, file);
  }

  public forget(folder: string): void {
    fs.rmSync(path.dirname(this.fileOf(path.resolve(folder))), { recursive: true, force: true });
  }

  private fileOf(resolved: string): string {
    return path.join(this.root, keyOf(resolved), FILE);
  }

  private damaged(file: string, folder: string, why: string): null {
    const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let kept = `kept as ${path.basename(aside)}`;
    try {
      fs.renameSync(file, aside);
    } catch (error) {
      kept = `and could not be moved aside (${(error as Error).message})`;
    }
    console.error(
      `[automations] The applied version of ${folder} reads as none: ${why}; ${kept}. The folder applies as on its first start.`,
    );
    return null;
  }
}
