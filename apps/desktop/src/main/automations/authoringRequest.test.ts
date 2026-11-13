import { describe, expect, it } from 'vitest';
import { MAX_AUTHORING_DESCRIPTION, parseAuthoringRequest } from './authoringRequest';

describe('parseAuthoringRequest', () => {
    it('accepts a description, with or without a scope or basis', () => {
        expect(parseAuthoringRequest({ workspaceId: 'w1', description: 'Digest' })).toEqual({
            workspaceId: 'w1',
            description: 'Digest',
        });
        expect(
            parseAuthoringRequest({ workspaceId: 'w1', description: '', scopeId: 's1', basis: { template: 'x' } })
        ).toEqual({ workspaceId: 'w1', description: '', scopeId: 's1', basis: { template: 'x' } });
        expect(parseAuthoringRequest({ workspaceId: 'w1', description: '', basis: { automation: 'a' } }).basis).toEqual({
            automation: 'a',
        });
    });

    it('refuses a malformed request', () => {
        expect(() => parseAuthoringRequest(null)).toThrow();
        expect(() => parseAuthoringRequest({ description: 'x' })).toThrow('Workspace id');
        expect(() => parseAuthoringRequest({ workspaceId: '', description: 'x' })).toThrow('Workspace id');
        expect(() => parseAuthoringRequest({ workspaceId: 'w', description: 3 })).toThrow('text');
        expect(() => parseAuthoringRequest({ workspaceId: 'w', description: 'x', scopeId: 4 })).toThrow('Scope');
    });

    it('caps the description', () => {
        const long = 'a'.repeat(MAX_AUTHORING_DESCRIPTION + 1);
        expect(() => parseAuthoringRequest({ workspaceId: 'w', description: long })).toThrow('under');
        expect(parseAuthoringRequest({ workspaceId: 'w', description: long.slice(1) }).description).toHaveLength(
            MAX_AUTHORING_DESCRIPTION
        );
    });

    it('accepts only exactly one automation or one template as the basis', () => {
        const bad = [{}, { automation: 1 }, { template: 't', automation: 'a' }, { other: 'x' }, 'x', [], null];
        for (const basis of bad) {
            expect(() => parseAuthoringRequest({ workspaceId: 'w', description: 'x', basis })).toThrow('basis');
        }
    });
});
