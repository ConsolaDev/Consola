import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_LABS, NO_LABS } from '../shared/labs';
import { labsFile, readLabs } from './labs';

describe('readLabs', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-labs-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const write = (text: string) => {
    fs.mkdirSync(path.dirname(labsFile(home)), { recursive: true });
    fs.writeFileSync(labsFile(home), text);
  };

  it('reads ~/.consola/labs.json outside a test run', () => {
    write('{"automations": true}');
    expect(labsFile(home)).toBe(path.join(home, '.consola', 'labs.json'));
    expect(readLabs({ test: false, env: {}, file: labsFile(home) })).toEqual({ automations: true });
  });

  it('turns nothing on when the computer has no labs file', () => {
    expect(readLabs({ test: false, env: {}, file: labsFile(home) })).toEqual(NO_LABS);
  });

  it('never reads the file in a test run: every lab is on unless CONSOLA_E2E_LABS says', () => {
    write('{"automations": false}');
    expect(readLabs({ test: true, env: {}, file: labsFile(home) })).toEqual(ALL_LABS);
    expect(readLabs({ test: true, env: { CONSOLA_E2E_LABS: '{}' }, file: labsFile(home) })).toEqual(
      NO_LABS,
    );
  });

  it('ignores CONSOLA_E2E_LABS outside a test run', () => {
    expect(
      readLabs({
        test: false,
        env: { CONSOLA_E2E_LABS: '{"automations": true}' },
        file: labsFile(home),
      }),
    ).toEqual(NO_LABS);
  });
});
