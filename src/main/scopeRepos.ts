import * as fs from 'fs';
import * as path from 'path';
import type { ScopeRepo } from '../shared/types';

/**
 * The launch targets inside a scope.
 *
 * A repo scope is its own single target. A container scope (a 38-repo parent
 * folder) offers its direct children that are git repos — exactly one level
 * down, because that is what the scope's folder layout means; anything deeper
 * deserves a scope of its own.
 */
export async function listScopeRepos(scope: {
    path: string;
    isGitRepo: boolean;
}): Promise<ScopeRepo[]> {
    if (scope.isGitRepo) {
        return [{ name: path.basename(scope.path), path: scope.path }];
    }

    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(scope.path, { withFileTypes: true });
    } catch {
        // A moved or unreadable folder offers no targets. The dialog shows an
        // empty list; an error dialog would be worse than the truth.
        return [];
    }

    const repos: ScopeRepo[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childPath = path.join(scope.path, entry.name);
        if (fs.existsSync(path.join(childPath, '.git'))) {
            repos.push({ name: entry.name, path: childPath });
        }
    }
    return repos.sort((a, b) => a.name.localeCompare(b.name));
}
