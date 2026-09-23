import type { GitProviderId } from '../../shared/providers';
import type { InboxItem, InboxSnapshot, WorkItemRef } from '../../shared/workItems';
import { sameWorkItem } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';

/** Spec cadence: a timer refresh every 3 minutes. */
export const INBOX_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
/** Focus events arrive in bursts (click-through between windows); refresh once. */
const FOCUS_REFRESH_MIN_GAP_MS = 30 * 1000;

export interface InboxServiceDeps {
  getWorkspace(workspaceId: string): Workspace | undefined;
  /** Every workspace with a provider binding — the set the timer and focus poll. */
  getBoundWorkspaceIds(): string[];
  /** getProviderDriver — throws on an unknown id; the message becomes the label. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  /** Login env plus this account's token, under the driver's variable. Throws when the token cannot be borrowed. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** Push one workspace's snapshot to every renderer. */
  broadcast(snapshot: InboxSnapshot): void;
}

/**
 * The per-workspace Inbox: one fetcher, one cache, one rate budget.
 *
 * Renderers never fetch. Main refreshes on window focus, on a manual intent,
 * and on a timer; results land in an in-memory cache and go out on
 * inbox:changed. A failed refresh never discards the last good list — it
 * re-broadcasts it with `error` set, and the UI labels the staleness. Which
 * provider does the fetching is the workspace's binding's business; this
 * service only ever holds a GitProviderDriver.
 */
export class InboxService {
  private readonly snapshots = new Map<string, InboxSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastFocusRefresh = 0;

  constructor(private readonly deps: InboxServiceDeps) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), INBOX_REFRESH_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public onWindowFocus(): void {
    const now = Date.now();
    if (now - this.lastFocusRefresh < FOCUS_REFRESH_MIN_GAP_MS) return;
    this.lastFocusRefresh = now;
    void this.refreshAll();
  }

  public getSnapshot(workspaceId: string): InboxSnapshot | null {
    return this.snapshots.get(workspaceId) ?? null;
  }

  /** The cached item for a work item, for seed prompts and session names. */
  public findItem(workspaceId: string, ref: WorkItemRef): InboxItem | undefined {
    return this.snapshots
      .get(workspaceId)
      ?.items.find((item) => sameWorkItem(item.workItem, ref));
  }

  /** Refresh one workspace, coalescing concurrent calls into one fetch. */
  public refresh(workspaceId: string): Promise<void> {
    const running = this.inFlight.get(workspaceId);
    if (running) return running;
    const job = this.doRefresh(workspaceId).finally(() => this.inFlight.delete(workspaceId));
    this.inFlight.set(workspaceId, job);
    return job;
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(this.deps.getBoundWorkspaceIds().map((id) => this.refresh(id)));
  }

  private async doRefresh(workspaceId: string): Promise<void> {
    const workspace = this.deps.getWorkspace(workspaceId);
    const provider = workspace?.provider;
    if (!provider) {
      // Unbound (or unbound since last fetch): nothing to show, nothing stale.
      this.snapshots.delete(workspaceId);
      return;
    }

    const previous = this.snapshots.get(workspaceId);
    try {
      // Resolved inside the try on purpose: an unknown provider id is one
      // more way the fetch cannot happen, and it degrades like the others.
      const driver = this.deps.resolveDriver(provider.id);
      const env = await this.deps.composeEnv(driver, provider.accountLogin);
      const items = await driver.fetchInbox(
        { accountLogin: provider.accountLogin, org: provider.org },
        env
      );
      this.adopt({ workspaceId, items, fetchedAt: Date.now() });
    } catch (error) {
      // Degrade, never dialog: keep the last good list and its age, label why.
      this.adopt({
        workspaceId,
        items: previous?.items ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: describeError(error),
      });
    }
  }

  private adopt(snapshot: InboxSnapshot): void {
    this.snapshots.set(snapshot.workspaceId, snapshot);
    this.deps.broadcast(snapshot);
  }
}
