import { describe, expect, it } from 'vitest';
import { basename } from './fileUtils';

describe('basename', () => {
    it('names the last segment of a posix path', () => {
        expect(basename('/repos/sympower/flex-portal')).toBe('flex-portal');
    });

    it('names the last segment of a windows path', () => {
        expect(basename('C:\\repos\\sympower\\flex-portal')).toBe('flex-portal');
    });

    it('ignores trailing separators, so a folder path still names its folder', () => {
        expect(basename('/repos/sympower/flex-portal/')).toBe('flex-portal');
    });

    it('names a bare segment as itself', () => {
        expect(basename('flex-portal')).toBe('flex-portal');
    });

    it('has nothing to name for the root', () => {
        expect(basename('/')).toBe('');
    });
});
