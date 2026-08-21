import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InboxItem, InboxSnapshot, WorkItemRef } from '../../shared/github';
import { sameWorkItem } from '../../shared/github';
import type { Workspace } from '../../shared/workspace';
import { INBOX_QUERY, parseInboxPayload, searchStrings } from './parseInbox';

const execFileAsync = promisify(execFile);

/** Spec cadence: a timer refresh every 3 minutes. */
export const INBOX_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
/** Focus events arrive in bursts (click-through between windows); refresh once. */
const FOCUS_REFRESH_MIN_GAP_MS = 30 * 1000;

export interface GitHubServiceDeps {
  getWorkspace(workspaceId: string): Workspace | undefined;
  /** Every workspace with a github binding — the set the timer and focus poll. */
  getGitHubWorkspaceIds(): string[];
  /** GhBroker.token — throws with gh's stderr; the message becomes the label. */
  token(accountLogin: string): Promise<string>;
  ghBinary(): Promise<string>;
  /** The ambient login env; GH_TOKEN is layered on top per call. */
  baseEnv(): NodeJS.ProcessEnv;
  /** Push one workspace's snapshot to every renderer. */
  broadcast(snapshot: InboxSnapshot): void;
}

function describeExecError(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim();
  if (stderr) return stderr;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The per-workspace GitHub Inbox: one fetcher, one cache, one rate budget.
 *
 * Renderers never fetch. Main refreshes on window focus, on a manual intent,
 * and on a timer; results land in an in-memory cache and go out on
 * github:inbox-changed. A failed refresh never discards the last good list —
 * it re-broadcasts it with `error` set, and the UI labels the staleness.
 */
export class GitHubService {
  private readonly snapshots = new Map<string, InboxSnapshot>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastFocusRefresh = 0;

  constructor(private readonly deps: GitHubServiceDeps) {}

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
    await Promise.all(this.deps.getGitHubWorkspaceIds().map((id) => this.refresh(id)));
  }

  private async doRefresh(workspaceId: string): Promise<void> {
    const workspace = this.deps.getWorkspace(workspaceId);
    const github = workspace?.github;
    if (!github) {
      // Unbound (or unbound since last fetch): nothing to show, nothing stale.
      this.snapshots.delete(workspaceId);
      return;
    }

    const previous = this.snapshots.get(workspaceId);
    try {
      const [binary, token] = await Promise.all([
        this.deps.ghBinary(),
        this.deps.token(github.accountLogin),
      ]);
      const searches = searchStrings(github.accountLogin, github.org);
      const { stdout } = await execFileAsync(
        binary,
        [
          'api',
          'graphql',
          '-f',
          `query=${INBOX_QUERY}`,
          '-f',
          `assigned=${searches.assigned}`,
          '-f',
          `authored=${searches.authored}`,
          '-f',
          `reviewRequested=${searches.reviewRequested}`,
        ],
        {
          env: { ...this.deps.baseEnv(), GH_TOKEN: token } as { [key: string]: string },
          maxBuffer: 10 * 1024 * 1024,
        }
      );
      this.adopt({
        workspaceId,
        items: parseInboxPayload(JSON.parse(stdout)),
        fetchedAt: Date.now(),
      });
    } catch (error) {
      // Degrade, never dialog: keep the last good list and its age, label why.
      this.adopt({
        workspaceId,
        items: previous?.items ?? [],
        fetchedAt: previous?.fetchedAt ?? 0,
        error: describeExecError(error),
      });
    }
  }

  private adopt(snapshot: InboxSnapshot): void {
    this.snapshots.set(snapshot.workspaceId, snapshot);
    this.deps.broadcast(snapshot);
  }
}
