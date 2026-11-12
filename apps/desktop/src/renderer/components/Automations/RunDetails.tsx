import type { AgentRunPreview } from '../../../shared/automations';
import type { CleanupResult, SessionVerdict, StalePreview } from '../../../shared/sessionCleanup';
import './styles.css';

/*
 * What a run waiting for approval shows, shared by Settings › Automations and
 * the Assistant's tray so the person approves from the same details in both.
 */

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

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
