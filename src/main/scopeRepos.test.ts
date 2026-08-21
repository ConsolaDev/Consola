import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listScopeRepos } from './scopeRepos';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-scope-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('listScopeRepos', () => {
    it("lists a container scope's direct child git repos, sorted by name", async () => {
        fs.mkdirSync(path.join(dir, 'repo-b', '.git'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'repo-a', '.git'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'not-a-repo'));
        fs.writeFileSync(path.join(dir, 'README.md'), 'not a directory');

        const repos = await listScopeRepos({ path: dir, isGitRepo: false });

        expect(repos).toEqual([
            { name: 'repo-a', path: path.join(dir, 'repo-a') },
            { name: 'repo-b', path: path.join(dir, 'repo-b') },
        ]);
    });

    it('offers a repo scope as its own single target', async () => {
        fs.mkdirSync(path.join(dir, '.git'));

        const repos = await listScopeRepos({ path: dir, isGitRepo: true });

        expect(repos).toEqual([{ name: path.basename(dir), path: dir }]);
    });

    it('returns no targets for a folder that cannot be read', async () => {
        const repos = await listScopeRepos({ path: path.join(dir, 'gone'), isGitRepo: false });

        expect(repos).toEqual([]);
    });
});
