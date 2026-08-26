import { useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { sectionFor } from '../../../shared/inboxSections';
import { PROVIDER_META } from '../../../shared/providers';
import { sessionLabel } from '../../../shared/sessionLabel';
import { defaultActionFor } from '../../../shared/workItemActions';
import type { InboxItem, WorkItemLaunchAction } from '../../../shared/workItems';
import { sameWorkItem } from '../../../shared/workItems';
import type { Session, Workspace } from '../../../shared/workspace';
import { itemKey, launchKey, useInboxStore } from '../../stores/inboxStore';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import { formatAge } from './inboxPresentation';
import './styles.css';

export interface InboxItemPaneProps {
  workspace: Workspace;
  item: InboxItem;
  onClose: () => void;
}

/** Verbatim from the spec: the inline confirm that replaces a block. */
const CONFIRM_LABEL = 'Another session is working on this — Start anyway';

const STATUS_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  ready: 'ready',
  'needs-attention': 'needs you',
  done: 'done',
  exited: 'exited',
};

const REVIEW_LABELS: Record<InboxItem['reviewDecision'], string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Awaiting approval',
  none: 'No review',
};

function checksLabel(item: InboxItem): string {
  if (item.checks) {
    const parts = [`${item.checks.passed}/${item.checks.total} passing`];
    if (item.checks.failed > 0) parts.push(`${item.checks.failed} failing`);
    if (item.checks.pending > 0) parts.push(`${item.checks.pending} pending`);
    return parts.join(' · ');
  }
  return item.ciStatus ?? 'none';
}

/**
 * The right-hand detail pane (layout B): the item's provider facts, every
 * session on it, and the ways to add one — an action, a custom prompt, or
 * linking a session that already exists. Read-only against the provider;
 * the only verbs here create, open or link local sessions.
 *
 * The highlighted action is the section default, resolved here rather than
 * passed in: the pane knows the item, and the section is a pure function
 * of it.
 */
export function InboxItemPane({ workspace, item, onClose }: InboxItemPaneProps) {
  const terminals = useTerminalStore((state) => state.terminals);
  const launch = useInboxStore((state) => state.launch);
  const openClonePrompt = useInboxStore((state) => state.openClonePrompt);
  const launching = useInboxStore((state) => state.launching);
  const launchErrors = useInboxStore((state) => state.launchErrors);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);

  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');

  // Task 8 fix-wave rule: name the bound provider, never hardcode "GitHub".
  // The pane only ever renders under a provider-bound workspace in practice
  // (the Inbox view itself returns null without one), but the field is
  // optional on the type, so this degrades to a neutral label instead of
  // throwing on a stale prop.
  const providerName = workspace.provider
    ? PROVIDER_META[workspace.provider.id].displayName
    : 'the provider';

  const siblings = workspace.sessions.filter((session) =>
    sameWorkItem(session.workItem, item.workItem)
  );
  const statusOf = (session: Session) => sessionStatusFor(terminals[session.instanceId]);
  // Only the renderer knows terminal status, so the warning lives here: a
  // second session while one is mid-work is allowed, but not by accident.
  const busy = siblings.some((session) => {
    const status = statusOf(session);
    return status === 'working' || status === 'needs-attention';
  });

  const applicable = workspace.actions.filter((action) =>
    action.appliesTo.includes(item.workItem.type)
  );
  const section = sectionFor(item);
  const preferredId = section ? workspace.sectionDefaults[section] : undefined;
  const highlighted = defaultActionFor(workspace.actions, item.workItem.type, preferredId);

  // null means "asked main, and no scope has it"; undefined means "not
  // asked yet", which optimistically reads as cloned — the launch corrects it.
  const uncloned = resolved?.[item.workItem.repo] === null;
  const repoKey = itemKey(workspace.id, item);

  // One key space for launch state: `key` here is always a launchKey string
  // (per action, or the custom prompt's own key) — including the inline
  // confirm, so confirmingKey never introduces a second key shape.
  const start = (action: WorkItemLaunchAction, key: string) => {
    if (busy && confirmingKey !== key) {
      setConfirmingKey(key);
      return;
    }
    setConfirmingKey(null);
    void launch(workspace.id, item, action);
  };

  const repoShort = item.workItem.repo.split('/').pop() ?? item.workItem.repo;
  const trimmedCustom = customPrompt.trim();
  const customKey = launchKey(workspace.id, item, { customPrompt: trimmedCustom });

  return (
    <aside className="inbox-pane" data-testid="inbox-pane" aria-label="Work item details">
      <div className="inbox-pane-header">
        <h2 className="inbox-pane-title">{item.title}</h2>
        <button className="inbox-pane-close" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </div>
      <div className="inbox-pane-meta">
        {item.workItem.repo}#{item.workItem.number} · {item.author} ·{' '}
        <a className="inbox-pane-link" href={item.url} target="_blank" rel="noreferrer">
          Open on {providerName} <ExternalLink size={11} />
        </a>
      </div>

      {item.workItem.type === 'pr' && (
        <>
          <div className="inbox-pane-section-title">{providerName}</div>
          <div className="inbox-pane-kv">
            <span>Review</span>
            <span>{REVIEW_LABELS[item.reviewDecision]}</span>
          </div>
          <div className="inbox-pane-kv">
            <span>Checks</span>
            <span>{checksLabel(item)}</span>
          </div>
          {(item.additions !== undefined || item.deletions !== undefined) && (
            <div className="inbox-pane-kv">
              <span>Diff</span>
              <span>
                +{item.additions ?? 0} −{item.deletions ?? 0}
              </span>
            </div>
          )}
        </>
      )}

      <div className="inbox-pane-section-title">Sessions · {siblings.length}</div>
      {siblings.length === 0 && <p className="inbox-pane-empty">No sessions on this item yet.</p>}
      {siblings.map((session) => {
        const status = statusOf(session);
        return (
          <div className="inbox-pane-session-row" key={session.id}>
            <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
            <div className="inbox-pane-session-text">
              <span className="inbox-pane-session-label">{sessionLabel(session)}</span>
              <span className="inbox-pane-session-sub">
                {STATUS_WORDS[status]} · {formatAge(session.lastActiveAt)}
                {session.cwd ? ` · ${basename(session.cwd)}` : ''}
              </span>
            </div>
            <button
              className="inbox-pane-open"
              onClick={() => activateSession(workspace.id, session.id)}
              aria-label={`Open ${sessionLabel(session)}`}
            >
              Open
            </button>
          </div>
        );
      })}
      <button
        className="inbox-pane-secondary"
        onClick={() =>
          useLinkSessionDialogStore.getState().open({
            kind: 'pick-session',
            workspaceId: workspace.id,
            item,
          })
        }
      >
        Link existing session...
      </button>

      <div className="inbox-pane-section-title">Start a session</div>
      {uncloned ? (
        <>
          <p className="inbox-pane-hint">
            {repoShort} is not cloned in any scope of this workspace.
          </p>
          <button
            className="inbox-pane-action inbox-pane-clone"
            disabled={launching[repoKey]}
            onClick={() => openClonePrompt(workspace.id, item)}
          >
            {launching[repoKey] ? 'Cloning...' : 'Clone into scope...'}
          </button>
          {launchErrors[repoKey] && (
            <span className="inbox-pane-action-error">{launchErrors[repoKey]}</span>
          )}
        </>
      ) : (
        <div className="inbox-pane-actions">
          {applicable.length === 0 && (
            <p className="inbox-pane-hint">
              No actions apply to {item.workItem.type === 'pr' ? 'pull requests' : 'issues'} —
              add one in Workspace settings.
            </p>
          )}
          {applicable.map((action) => {
            const key = launchKey(workspace.id, item, { id: action.id });
            const confirming = confirmingKey === key;
            return (
              <div className="inbox-pane-action-slot" key={action.id}>
                <button
                  className={`inbox-pane-action ${
                    highlighted?.id === action.id ? 'inbox-pane-action--default' : ''
                  } ${confirming ? 'inbox-pane-action--confirm' : ''}`}
                  data-action-id={action.id}
                  disabled={launching[key]}
                  onClick={() => start({ id: action.id }, key)}
                >
                  {launching[key] ? 'Preparing...' : confirming ? CONFIRM_LABEL : action.name}
                </button>
                {launchErrors[key] && (
                  <span className="inbox-pane-action-error">{launchErrors[key]}</span>
                )}
              </div>
            );
          })}
          {customOpen ? (
            <div className="inbox-pane-custom">
              <textarea
                className="inbox-pane-custom-textarea"
                rows={3}
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
                placeholder="A one-off prompt. Placeholders: {{number}} {{repo}} {{title}} {{url}} {{type}}"
                aria-label="Custom prompt"
                autoFocus
              />
              <div className="inbox-pane-custom-actions">
                <button
                  className="inbox-pane-secondary"
                  onClick={() => {
                    setCustomOpen(false);
                    setConfirmingKey(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={`inbox-pane-action ${
                    confirmingKey === customKey ? 'inbox-pane-action--confirm' : ''
                  }`}
                  data-action-id="custom"
                  disabled={trimmedCustom.length === 0 || launching[customKey]}
                  onClick={() => start({ customPrompt: trimmedCustom }, customKey)}
                >
                  {launching[customKey]
                    ? 'Preparing...'
                    : confirmingKey === customKey
                      ? CONFIRM_LABEL
                      : 'Start'}
                </button>
              </div>
              {launchErrors[customKey] && (
                <span className="inbox-pane-action-error">{launchErrors[customKey]}</span>
              )}
            </div>
          ) : (
            <button className="inbox-pane-secondary" onClick={() => setCustomOpen(true)}>
              Custom prompt...
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
