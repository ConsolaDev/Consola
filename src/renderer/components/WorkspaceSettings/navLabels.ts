import type { Workspace } from '../../../shared/workspace';
import { PROVIDER_META, isGitProviderId } from '../../../shared/providers';

/**
 * The Provider nav item's label: the bound provider's own display name once
 * one is chosen ("GitHub"), the generic word before that.
 *
 * Falls back rather than throwing on an id PROVIDER_META no longer lists — a
 * persisted binding must never make the modal itself unrenderable, or the
 * one place that could fix the binding would be the place that crashes.
 */
export function providerNavLabel(workspace: Workspace): string {
  const provider = workspace.provider;
  if (!provider || !isGitProviderId(provider.id)) return 'Provider';
  return PROVIDER_META[provider.id].displayName;
}
