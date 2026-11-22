import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AppliedFactory } from '../ports';
import { AppliedFactoryFiles } from './appliedFactory';

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-applied-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FOLDER = '/home/alice/.consola/workspaces/ws-1';
const keyOf = (folder: string) =>
  createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 16);

const APPLIED: AppliedFactory = {
  folder: FOLDER,
  appliedAt: '2026-11-22T08:00:00.000Z',
  clean: true,
  texts: {
    'factory.yml': 'version: 1\nautomations: []\n',
    'automations/catalog-review.yaml': 'on: manual\nsteps:\n  - agent: reviewer\n',
    'agents/reviewer.md': 'You review.\n',
  },
};

describe('AppliedFactoryFiles', () => {
  it('reads null for a folder never written, and logs nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    expect(new AppliedFactoryFiles(tmp()).read(FOLDER)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('round-trips a write', () => {
    const store = new AppliedFactoryFiles(tmp());
    store.write(APPLIED);
    expect(store.read(FOLDER)).toEqual(APPLIED);
    store.write({ ...APPLIED, clean: false, texts: { 'agents/reviewer.md': 'You review.\n' } });
    expect(store.read(FOLDER)).toEqual({
      ...APPLIED,
      clean: false,
      texts: { 'agents/reviewer.md': 'You review.\n' },
    });
  });

  it('keeps one file per folder, keyed by the resolved path', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    const other = '/home/alice/.consola/workspaces/ws-2';
    store.write(APPLIED);
    store.write({ ...APPLIED, folder: other, clean: false });
    expect(fs.readdirSync(root).sort()).toEqual([keyOf(FOLDER), keyOf(other)].sort());
    expect(keyOf(FOLDER)).toMatch(/^[0-9a-f]{16}$/);
    expect(fs.readdirSync(path.join(root, keyOf(FOLDER)))).toEqual(['applied.json']);
    expect(store.read(other)?.clean).toBe(false);
    expect(store.read(FOLDER)?.clean).toBe(true);
    // A trailing slash, or a dot segment, names the same folder.
    expect(store.read(`${FOLDER}/`)).toEqual(APPLIED);
    expect(store.read('/home/alice/.consola/workspaces/./ws-1')).toEqual(APPLIED);
  });

  it.each([
    ['not JSON', 'not json at all {'],
    ['JSON of another shape', JSON.stringify({ version: 1, folder: FOLDER })],
    ['another version', JSON.stringify({ ...APPLIED, version: 2 })],
    ['a text that is no string', JSON.stringify({ ...APPLIED, version: 1, texts: { a: 3 } })],
    ['texts that are a list', JSON.stringify({ ...APPLIED, version: 1, texts: ['a'] })],
    ['clean that is no boolean', JSON.stringify({ ...APPLIED, version: 1, clean: 'yes' })],
    ['another folder', JSON.stringify({ ...APPLIED, version: 1, folder: '/elsewhere' })],
  ])('%s reads as none, logged once and renamed aside as it was', (_label, bytes) => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    const dir = path.join(root, keyOf(FOLDER));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'applied.json'), bytes);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());

    expect(store.read(FOLDER)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const left = fs.readdirSync(dir);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^applied\.json\.damaged-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    expect(fs.readFileSync(path.join(dir, left[0]), 'utf8')).toBe(bytes);
    // Read as none from then on, and logged no more.
    expect(store.read(FOLDER)).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a write leaves no temporary file', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    store.write(APPLIED);
    store.write({ ...APPLIED, appliedAt: '2026-11-22T09:00:00.000Z' });
    expect(fs.readdirSync(path.join(root, keyOf(FOLDER)))).toEqual(['applied.json']);
  });

  it('forget removes the folder’s entry', () => {
    const root = tmp();
    const store = new AppliedFactoryFiles(root);
    store.write(APPLIED);
    store.forget(FOLDER);
    expect(fs.existsSync(path.join(root, keyOf(FOLDER)))).toBe(false);
    expect(store.read(FOLDER)).toBeNull();
    // Forgetting what was never written is no error.
    store.forget('/home/alice/.consola/workspaces/ws-9');
  });
});
