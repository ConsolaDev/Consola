import { describe, expect, it } from 'vitest';
import { scopeTrail } from './scopeTrail';

const scope = (id: string, name: string, path: string) => ({ id, name, path });

describe('scopeTrail', () => {
  const root = scope('root', 'sprocket', '/Users/dev/sprocket');
  const api = scope('api', 'api', '/Users/dev/sprocket/apps/api');
  const portal = scope('portal', 'catalog-portal', '/Users/dev/catalog-portal');

  it('names a scope inside no other scope on its own', () => {
    expect(scopeTrail([root, api, portal], root)).toEqual({ label: 'sprocket' });
    expect(scopeTrail([root, api, portal], portal)).toEqual({ label: 'catalog-portal' });
  });

  it('puts the containing scope before a folder inside it, with the path between them', () => {
    expect(scopeTrail([root, api], api)).toEqual({ parent: 'sprocket', label: 'apps/api' });
  });

  it('keeps a name the person chose over the path', () => {
    const renamed = scope('api', 'Backend', '/Users/dev/sprocket/apps/api');
    expect(scopeTrail([root, renamed], renamed)).toEqual({ parent: 'sprocket', label: 'Backend' });
  });

  it('measures from the nearest containing scope', () => {
    const apps = scope('apps', 'apps', '/Users/dev/sprocket/apps');
    expect(scopeTrail([root, apps, api], api)).toEqual({ parent: 'apps', label: 'api' });
  });

  it('does not mistake a sibling sharing a name prefix for a parent', () => {
    const sibling = scope('sib', 'sprocket-docs', '/Users/dev/sprocket-docs');
    expect(scopeTrail([root, sibling], sibling)).toEqual({ label: 'sprocket-docs' });
  });

  it('ignores trailing separators and treats a duplicate folder as no parent', () => {
    const slashed = scope('slash', 'api', '/Users/dev/sprocket/apps/api/');
    expect(scopeTrail([scope('root', 'sprocket', '/Users/dev/sprocket/'), slashed], slashed))
      .toEqual({ parent: 'sprocket', label: 'apps/api' });
    const twin = scope('twin', 'sprocket', '/Users/dev/sprocket');
    expect(scopeTrail([root, twin], twin)).toEqual({ label: 'sprocket' });
  });

  it('reads Windows separators the same way', () => {
    const winRoot = scope('root', 'sprocket', 'C:\\dev\\sprocket');
    const winApi = scope('api', 'api', 'C:\\dev\\sprocket\\apps\\api');
    expect(scopeTrail([winRoot, winApi], winApi)).toEqual({ parent: 'sprocket', label: 'apps/api' });
  });
});
