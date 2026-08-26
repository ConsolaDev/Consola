import { describe, expect, it } from 'vitest';
import {
  isValidWorkItemRef,
  sameWorkItem,
  toWorkItemRef,
  workItemActionKey,
  workItemKey,
  workItemUrl,
  type WorkItemRef,
} from './workItems';

const pr51: WorkItemRef = { provider: 'github', repo: 'sympower/controller-app', type: 'pr', number: 51 };

describe('sameWorkItem', () => {
  it('matches identical refs', () => {
    expect(sameWorkItem(pr51, { ...pr51 })).toBe(true);
  });

  it('matches case-insensitively on repo — GitHub repo names are case-insensitive', () => {
    expect(sameWorkItem(pr51, { ...pr51, repo: 'Sympower/Controller-App' })).toBe(true);
  });

  it('distinguishes number, type, and repo', () => {
    expect(sameWorkItem(pr51, { ...pr51, number: 52 })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, type: 'issue' })).toBe(false);
    expect(sameWorkItem(pr51, { ...pr51, repo: 'sympower/flex-portal' })).toBe(false);
  });

  it('is false when either side is absent — sessions without a workItem match nothing', () => {
    expect(sameWorkItem(undefined, pr51)).toBe(false);
    expect(sameWorkItem(pr51, undefined)).toBe(false);
    expect(sameWorkItem(undefined, undefined)).toBe(false);
  });
});

describe('workItemKey', () => {
  it('is stable across repo casing', () => {
    expect(workItemKey(pr51)).toBe(workItemKey({ ...pr51, repo: 'SYMPOWER/controller-app' }));
  });

  it('differs across type', () => {
    expect(workItemKey(pr51)).not.toBe(workItemKey({ ...pr51, type: 'issue' }));
  });
});

describe('workItemUrl', () => {
  it('builds the pull URL for PRs', () => {
    expect(workItemUrl(pr51)).toBe('https://github.com/sympower/controller-app/pull/51');
  });

  it('builds the issues URL for issues', () => {
    expect(workItemUrl({ ...pr51, type: 'issue', number: 87 })).toBe(
      'https://github.com/sympower/controller-app/issues/87'
    );
  });
});

describe('isValidWorkItemRef', () => {
  // This runs on an IPC payload before WorkspaceService links a session, so
  // every field is checked as an unknown, not trusted as a WorkItemRef.
  it('accepts a well-formed ref for a known provider', () => {
    expect(isValidWorkItemRef(pr51)).toBe(true);
    expect(isValidWorkItemRef({ ...pr51, type: 'issue', number: 87 })).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(isValidWorkItemRef({ ...pr51, provider: 'gitlab' })).toBe(false);
  });

  it('rejects a repo that is not owner/name', () => {
    expect(isValidWorkItemRef({ ...pr51, repo: 'controller-app' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: 'sympower/controller-app/extra' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: 'sym power/controller-app' })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, repo: '' })).toBe(false);
  });

  it('rejects a type other than pr or issue', () => {
    expect(isValidWorkItemRef({ ...pr51, type: 'pull' })).toBe(false);
  });

  it('rejects a number that is not a positive integer', () => {
    expect(isValidWorkItemRef({ ...pr51, number: 1.5 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: 0 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: -3 })).toBe(false);
    expect(isValidWorkItemRef({ ...pr51, number: '51' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidWorkItemRef(null)).toBe(false);
    expect(isValidWorkItemRef('github:sympower/controller-app:pr:51')).toBe(false);
    expect(isValidWorkItemRef(undefined)).toBe(false);
  });
});

describe('toWorkItemRef', () => {
  // Rebuilds from an allow-list, the same discipline setActions/setProviderBinding
  // use, so a payload that passed isValidWorkItemRef cannot smuggle stray keys
  // into workspaces.json.
  it('keeps only provider, repo, type, and number', () => {
    const withExtra = { ...pr51, token: 'ghp_secret', extra: 'nope' } as unknown as WorkItemRef;
    expect(toWorkItemRef(withExtra)).toEqual(pr51);
  });

  it('rebuilds a plain ref unchanged', () => {
    expect(toWorkItemRef(pr51)).toEqual(pr51);
  });
});

describe('workItemActionKey', () => {
  it('keys a stored action by id', () => {
    expect(workItemActionKey({ id: 'a-review' })).toBe('action:a-review');
  });

  it('keys a custom prompt by its trimmed body, so a retyped prompt coalesces', () => {
    expect(workItemActionKey({ customPrompt: '  /security-review \n' })).toBe(
      'custom:/security-review'
    );
    expect(workItemActionKey({ customPrompt: 'a' })).not.toBe(workItemActionKey({ customPrompt: 'b' }));
  });
});
