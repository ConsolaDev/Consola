import { describe, expect, it } from 'vitest';
import { basename } from './fileUtils';

describe('basename', () => {
    it('names the last segment of a posix path', () => {
        expect(basename('/repos/sprocket/forum-admin')).toBe('forum-admin');
    });

    it('names the last segment of a windows path', () => {
        expect(basename('C:\\repos\\sprocket\\forum-admin')).toBe('forum-admin');
    });

    it('ignores trailing separators, so a folder path still names its folder', () => {
        expect(basename('/repos/sprocket/forum-admin/')).toBe('forum-admin');
    });

    it('names a bare segment as itself', () => {
        expect(basename('forum-admin')).toBe('forum-admin');
    });

    it('has nothing to name for the root', () => {
        expect(basename('/')).toBe('');
    });
});
