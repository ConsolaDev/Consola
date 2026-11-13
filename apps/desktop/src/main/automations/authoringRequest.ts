import type { AuthoringBasis, AuthoringRequest } from '../../shared/automations';

/** The longest description the dialog may send: far past anything a person types. */
export const MAX_AUTHORING_DESCRIPTION = 4000;

/**
 * What crossed the IPC boundary, checked into an AuthoringRequest. `startAuthoring`
 * trusts its argument's shape, so this is where an untyped message is refused.
 */
export function parseAuthoringRequest(raw: unknown): AuthoringRequest {
    if (typeof raw !== 'object' || raw === null) throw new Error('Authoring request required.');
    const { workspaceId, description, scopeId, basis } = raw as Record<string, unknown>;
    if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('Workspace id required.');
    if (typeof description !== 'string') throw new Error('Description must be text.');
    if (description.length > MAX_AUTHORING_DESCRIPTION) {
        throw new Error(`Keep the description under ${MAX_AUTHORING_DESCRIPTION} characters.`);
    }
    if (scopeId !== undefined && typeof scopeId !== 'string') throw new Error('Scope id must be text.');
    const request: AuthoringRequest = { workspaceId, description };
    if (scopeId !== undefined) request.scopeId = scopeId;
    if (basis !== undefined) request.basis = parseBasis(basis);
    return request;
}

function parseBasis(raw: unknown): AuthoringBasis {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const keys = Object.keys(raw);
        const record = raw as Record<string, unknown>;
        if (keys.length === 1 && keys[0] === 'automation' && typeof record.automation === 'string') {
            return { automation: record.automation };
        }
        if (keys.length === 1 && keys[0] === 'template' && typeof record.template === 'string') {
            return { template: record.template };
        }
    }
    throw new Error('The basis must name one automation or one template.');
}
