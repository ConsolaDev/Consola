import { isValidWorkItemRef, toWorkItemRef } from '../../shared/workItems';
import { workItemMutationSchema } from '../../shared/workItemDetails';
import type { InboxServiceDeps } from './InboxService';

/** Resolve identity and credentials in main; renderer input never selects an account. */
export class WorkItemDetailService {
  private readonly pending = new Set<string>();
  constructor(private readonly deps: Pick<InboxServiceDeps, 'getWorkspace' | 'resolveDriver' | 'composeEnv'>) {}

  private async context(workspaceId: string, input: unknown) {
    if (!isValidWorkItemRef(input) || !/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
      throw new Error('Invalid work item.');
    }
    const provider = this.deps.getWorkspace(workspaceId)?.provider;
    if (!provider || provider.id !== input.provider) throw new Error('Work item does not match the workspace provider.');
    if (provider.org && input.repo.split('/')[0].toLowerCase() !== provider.org.toLowerCase()) {
      throw new Error('Work item is outside the workspace organization.');
    }
    const driver = this.deps.resolveDriver(provider.id);
    const env = await this.deps.composeEnv(driver, provider.accountLogin);
    return { driver, env, ref: toWorkItemRef(input) };
  }

  async get(workspaceId: string, input: unknown) {
    const { driver, env, ref } = await this.context(workspaceId, input);
    if (!driver.fetchDetails) throw new Error('This provider does not support item details yet.');
    return driver.fetchDetails(ref, env);
  }

  async mutate(workspaceId: string, input: unknown, action: unknown) {
    const mutation = workItemMutationSchema.parse(action);
    // Set synchronously before borrowing credentials, including across windows.
    const key = JSON.stringify([workspaceId, isValidWorkItemRef(input) ? [input.repo.toLowerCase(), input.type, input.number] : input]);
    if (this.pending.has(key)) throw new Error('An action on this item is already in progress.');
    this.pending.add(key);
    try {
      const { driver, env, ref } = await this.context(workspaceId, input);
      if (!driver.mutateItem) throw new Error('This provider does not support item actions yet.');
      await driver.mutateItem(ref, mutation, env);
    } finally {
      this.pending.delete(key);
    }
  }
}
