import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile, StateFileCorruptError } from './JsonStateFile';

interface Shape {
  version: number;
  items: string[];
}

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-state-'));
  filePath = path.join(dir, 'nested', 'state.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('JsonStateFile', () => {
  it('reports nothing written as null rather than as empty state', () => {
    const file = new JsonStateFile<Shape>(filePath);

    expect(file.exists()).toBe(false);
    expect(file.read()).toBeNull();
  });

  it('creates missing directories and round-trips a value', () => {
    const file = new JsonStateFile<Shape>(filePath);

    file.write({ version: 5, items: ['a'] });

    expect(file.exists()).toBe(true);
    expect(file.read()).toEqual({ version: 5, items: ['a'] });
  });

  it('leaves no temp file behind', () => {
    const file = new JsonStateFile<Shape>(filePath);

    file.write({ version: 5, items: ['a'] });

    const leftovers = fs.readdirSync(path.dirname(filePath)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('falls back to the backup when the primary is corrupt', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    fs.writeFileSync(filePath, '{ this is not json');

    expect(file.read()).toEqual({ version: 5, items: ['first'] });
  });

  it('throws rather than returning empty state when both copies are corrupt', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    fs.writeFileSync(filePath, '{ broken');
    fs.writeFileSync(`${filePath}.bak`, '{ also broken');

    expect(() => file.read()).toThrow(StateFileCorruptError);
  });

  it('keeps the last good backup when the primary is already corrupt', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    // Corruption from outside this class — a disk fault, a stray editor, a
    // half-flushed write from an older build.
    fs.writeFileSync(filePath, '{ corrupted externally');
    file.write({ version: 5, items: ['third'] });

    fs.writeFileSync(filePath, '{ corrupted again');

    // 'first' is the newest value that was ever known to parse. Promoting the
    // corrupt primary into .bak would have lost it.
    expect(file.read()).toEqual({ version: 5, items: ['first'] });
  });

  it('reads the backup when the primary is missing entirely', () => {
    const file = new JsonStateFile<Shape>(filePath);
    file.write({ version: 5, items: ['first'] });
    file.write({ version: 5, items: ['second'] });

    fs.rmSync(filePath);

    expect(file.read()).toEqual({ version: 5, items: ['first'] });
  });
});
