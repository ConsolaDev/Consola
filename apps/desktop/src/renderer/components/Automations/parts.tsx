import { useState } from 'react';
import type { AgentRunPreview, RunRecord } from '../../../shared/automations';
import type { CleanupResult, SessionVerdict, StalePreview } from '../../../shared/sessionCleanup';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import type { RunFacts } from './presentation';

/**
 * A run's status as a dot. Decorative: whatever shows one also says the
 * status in words.
 */
export function StatusDot({ status }: { status: RunFacts['status'] }) {
  return <span className={`automations-dot automations-dot-${status}`} aria-hidden="true" />;
}

/**
 * One intent sent to main at a time, with what went wrong kept to show
 * inline. `busy` is the key of the intent in flight.
 */
export function useIntent() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, intent: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await intent();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, act };
}

/** What an agent run will start: the item it is about, what it runs, and the exact prompt. */
export function AgentRunDetails({ preview }: { preview: AgentRunPreview }) {
  return (
    <div className="automations-details">
      {preview.item && (
        <div>
          <a href={preview.item.url} target="_blank" rel="noreferrer">
            {preview.item.title}
          </a>{' '}
          by @{preview.item.author}
        </div>
      )}
      <div>
        {preview.runs}
        {preview.scope ? ` in ${preview.scope}` : ''}, read-only
      </div>
      <details>
        <summary>The prompt it will send</summary>
        <pre className="automations-prompt">{preview.prompt}</pre>
      </details>
    </div>
  );
}

/** The item an event run is about, linked; its title is the author's own text, shown as text. */
export function RunItemLink({ run, fallback }: { run: RunRecord; fallback?: string }) {
  const item = run.trigger.item;
  if (!item) return <>{fallback ?? null}</>;
  return (
    <a href={item.url} target="_blank" rel="noreferrer">
      {item.title}
    </a>
  );
}

/**
 * The sessions a cleanup preview would remove, or a cleanup run removed, and
 * the ones kept with their reasons. Results of other tools render nothing.
 */
export function CleanupDetails({ result }: { result: unknown }) {
  if (!isCleanupData(result)) return null;
  const going = 'candidates' in result ? result.candidates : [];
  const kept = result.skipped;
  return (
    <div className="automations-details">
      {going.length > 0 && (
        <ul>
          {going.map((verdict) => (
            <li key={verdict.sessionId}>
              <strong>{verdict.sessionName}</strong>
              {verdict.pullRequest ? ` — #${verdict.pullRequest.number} ${verdict.pullRequest.status}` : ''}
              {diskEffect(verdict)}
            </li>
          ))}
        </ul>
      )}
      {kept.length > 0 && (
        <details>
          <summary>{kept.length} kept</summary>
          <ul>
            {kept.map((verdict) => (
              <li key={verdict.sessionId}>
                <strong>{verdict.sessionName}</strong> — {verdict.detail ?? verdict.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function isCleanupData(result: unknown): result is StalePreview | CleanupResult {
  return typeof result === 'object' && result !== null && Array.isArray((result as { skipped?: unknown }).skipped);
}

function diskEffect(verdict: SessionVerdict): string {
  if (!verdict.worktree) return '';
  if (!verdict.worktree.remove) return ` · keeps its worktree (${verdict.worktree.keptBecause})`;
  const folder = verdict.worktree.path.split(/[\\/]/).pop();
  return ` · removes ${folder}${verdict.branch ? ` and ${verdict.branch}` : ''}`;
}
