import { describe, expect, it } from 'vitest';
import { resolvePath } from './paths';

describe('resolvePath', () => {
  it.each([
    ['/home/user', '/tmp/a.txt', '/tmp/a.txt'],
    ['/home/user', 'a.txt', '/home/user/a.txt'],
    ['/home/user', './dir/../a.txt', '/home/user/a.txt'],
    ['/home/user', '../../../etc', '/etc'],
    ['/', '//tmp//a/', '/tmp/a'],
    ['/tmp', '.', '/tmp'],
    ['/tmp', '..', '/'],
  ])('from %s, %s is %s', (base, path, resolved) => {
    expect(resolvePath(base, path)).toBe(resolved);
  });
});
