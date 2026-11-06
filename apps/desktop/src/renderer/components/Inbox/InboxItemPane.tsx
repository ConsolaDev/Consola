import { WorkItemDetailPanel } from './WorkItemDetailPanel';
import { useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  FolderDown,
  Link2,
  LoaderCircle,
  PenLine,
  Play,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { sectionFor } from '../../../shared/inboxSections';
import { PROVIDER_META } from '../../../shared/providers';
import { sessionLabel } from '../../../shared/sessionLabel';
import { defaultActionFor } from '../../../shared/workItemActions';
import type { InboxItem, WorkItemLaunchAction, WorkItemRef } from '../../../shared/workItems';
import { sameWorkItem } from '../../../shared/workItems';
import type { WorkItemDetails } from '../../../shared/workItemDetails';
import type { Session, Workspace } from '../../../shared/workspace';
import { itemKey, launchKey, useInboxStore } from '../../stores/inboxStore';
import { useLinkSessionDialogStore } from '../../stores/linkSessionDialogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { basename } from '../../utils/fileUtils';
import { activateSession } from '../../utils/sessionActions';
import { sessionStatusFor, type SessionStatus } from '../../utils/sessionStatus';
import { MOD_KEY, formatAge, isSubmitChord, prefersReducedMotion } from './inboxPresentation';
import { StateBadge } from './WorkItemDetailParts';
import { itemStatus } from './workItemDetailPresentation';
import './styles.css';

export interface InboxItemPaneProps {
  workspace: Workspace;
  item: InboxItem;
  onClose: () => void;
  /**
   * The session this pane sits beside, when it does (WorkItemPanel). Its row
   * says so instead of offering to open what is already open.
   */
  currentSessionId?: string;
  /**
   * Beside a session, a Fix is handed to that session rather than drafted as
   * a new one. A returned string is why it could not be.
   */
  fixInSession?: (prompt: string) => string | void;
  /**
   * Opens another item in this pane when the Inbox lists it (a pull request
   * an event mentions). False, or absent beside a session, means the link
   * opens on the provider instead.
   */
  onOpenWorkItem?: (ref: WorkItemRef) => boolean;
}

/** Verbatim from the spec: the inline confirm that replaces a block. */
const CONFIRM_LABEL = 'Another session is working on this — Start anyway';

/** What a custom prompt may name; substitutePlaceholders fills them at launch. */
const PLACEHOLDERS = ['number', 'repo', 'title', 'url', 'type'] as const;

const STATUS_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  ready: 'ready',
  'needs-attention': 'needs you',
  done: 'done',
  exited: 'exited',
};

/**
 * An automation's session in words: its unattended turn is running, or it
 * finished and what it found is in the tab. Anything else — the person
 * continued it — reads like any other session.
 */
function automationPhase(status: SessionStatus): string | null {
  if (status === 'working') return 'Reviewing…';
  if (status === 'exited') return 'Findings ready';
  return null;
}

/**
 * The right-hand detail pane (layout B): the item's sessions and the ways to
 * add one — an action, a custom prompt, or linking a session that already
 * exists — then the item itself, provided by WorkItemDetailPanel.
 *
 * Sessions come first, in a dock under the title and the item's one-line
 * status strip. They are what Consola adds to the item and the reason to
 * open it here rather than on GitHub, and they are local: the dock renders
 * at full height at once, where the remote details below arrive later and
 * would push anything under them down. The strip above is one line whether
 * or not they have arrived, so it does not move the dock either -- except in
 * the narrowest pane, where a PR's branches need a line of their own.
 *
 * The highlighted action is the section default, resolved here rather than
 * passed in: the pane knows the item, and the section is a pure function
 * of it.
 */
export function InboxItemPane({ workspace, item, onClose, currentSessionId, fixInSession, onOpenWorkItem }: InboxItemPaneProps) {
  const terminals = useTerminalStore((state) => state.terminals);
  const launch = useInboxStore((state) => state.launch);
  const openClonePrompt = useInboxStore((state) => state.openClonePrompt);
  const launching = useInboxStore((state) => state.launching);
  const launchErrors = useInboxStore((state) => state.launchErrors);
  const resolved = useInboxStore((state) => state.resolvedRepos[workspace.id]);

  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const customBoxRef = useRef<HTMLDivElement>(null);
  const customFieldRef = useRef<HTMLTextAreaElement>(null);
  const customToggleRef = useRef<HTMLButtonElement>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');
  // Each Fix handed over remounts the glow under this key, replaying it; it
  // clears itself once played, so reopening the prompt by hand stays quiet.
  const [landedKey, setLandedKey] = useState<number | null>(null);
  // Where the details panel draws the item's status strip: above the dock,
  // with the item's name, rather than down with its tabs.
  const [detailHead, setDetailHead] = useState<HTMLDivElement | null>(null);
  // The Inbox's copy lags a refresh behind, and a stand-in for an item it no
  // longer lists has no title at all: a fresh read is the better answer.
  const [fetched, setFetched] = useState<WorkItemDetails | null>(null);
  const title = fetched?.title ?? item.title;
  // The state is part of what the item is, so it sits with its name. An item
  // the Inbox no longer lists is stood in for with no state (''): no badge
  // until a read says, rather than a guess that would flip.
  const knownState = fetched?.state ?? item.state;
  const status = knownState
    ? itemStatus(item.workItem.type, knownState, fetched?.isDraft ?? item.isDraft, fetched?.stateReason)
    : null;

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

  const section = sectionFor(item);
  const preferredId = section ? workspace.sectionDefaults[section] : undefined;
  const highlighted = defaultActionFor(workspace.actions, item.workItem.type, preferredId);
  const actions = workspace.actions
    .filter((action) => action.appliesTo.includes(item.workItem.type))
    .map((action) => ({
      action,
      key: launchKey(workspace.id, item, { id: action.id }),
      // An automation already ran this action on this item: that session is
      // the review, so the button opens it. A custom prompt still starts a
      // new one on purpose. The newest: a re-requested review has an earlier
      // one on older code.
      automationReview: siblings
        .filter((session) => session.automation && session.workItemAction === action.name)
        .reduce<Session | undefined>(
          (newest, session) => (!newest || session.createdAt > newest.createdAt ? session : newest),
          undefined
        ),
    }));

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
  const canStartCustom = trimmedCustom.length > 0 && !launching[customKey];

  const closeCustom = () => {
    setCustomOpen(false);
    setConfirmingKey(null);
    // The field that had focus is gone; give it back to what opened it.
    requestAnimationFrame(() => customToggleRef.current?.focus());
  };

  // A Fix from the details below lands here as a drafted prompt: open it,
  // bring it into view, and mark where it landed.
  const receiveFix = (prompt: string) => {
    setCustomPrompt(prompt);
    setCustomOpen(true);
    setLandedKey((previous) => (previous ?? 0) + 1);
    requestAnimationFrame(() => {
      customFieldRef.current?.focus({ preventScroll: true });
      customBoxRef.current?.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    });
  };

  // Placeholders go in at the caret, replacing any selection, and the caret
  // lands after them so typing carries on.
  const insertPlaceholder = (token: string) => {
    const field = customFieldRef.current;
    const from = field?.selectionStart ?? customPrompt.length;
    const to = field?.selectionEnd ?? from;
    setCustomPrompt(customPrompt.slice(0, from) + token + customPrompt.slice(to));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(from + token.length, from + token.length);
    });
  };

  const onCustomKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // Handled here, so the Inbox's own Esc does not close the whole pane.
      event.preventDefault();
      closeCustom();
    } else if (isSubmitChord(event)) {
      event.preventDefault();
      if (canStartCustom) start({ customPrompt: trimmedCustom }, customKey);
    }
  };

  return (
    <aside className="inbox-pane" data-testid="inbox-pane" aria-label="Work item details">
      <div className="inbox-pane-header">
        <h2 className="inbox-pane-title">{title}</h2>
        <button className="inbox-pane-close" onClick={onClose} aria-label="Close details">
          <X size={14} />
        </button>
      </div>
      <div className="inbox-pane-meta">
        {/* Keyed by the state it shows, so a merge or close visibly lands. */}
        {status && <StateBadge key={status.kind} {...status} />}
        <span className="inbox-pane-meta-text">
          {item.workItem.repo}#{item.workItem.number} ·{' '}
          <a className="inbox-pane-link" href={item.url} target="_blank" rel="noreferrer">
            Open on {providerName} <ExternalLink size={11} />
          </a>
        </span>
      </div>
      {workspace.provider && <div ref={setDetailHead} className="inbox-pane-detail-head" />}

      <section className="inbox-pane-dock" aria-label="Sessions on this item">
        <div className="inbox-pane-dock-head">
          <h3 className="inbox-pane-section-title">
            Sessions
            {siblings.length > 0 && <span className="inbox-pane-count">{siblings.length}</span>}
          </h3>
          <button
            className="inbox-pane-link-session"
            onClick={() =>
              useLinkSessionDialogStore.getState().open({
                kind: 'pick-session',
                workspaceId: workspace.id,
                item,
              })
            }
          >
            <Link2 size={13} aria-hidden="true" />
            Link existing…
          </button>
        </div>

        {siblings.length === 0 ? (
          <p className="inbox-pane-empty">No sessions on this item yet.</p>
        ) : (
          <ul className="inbox-pane-sessions">
            {siblings.map((session) => {
              const status = statusOf(session);
              const phase = session.automation ? automationPhase(status) : null;
              const current = session.id === currentSessionId;
              return (
                <li
                  className="inbox-pane-session-row"
                  key={session.id}
                  data-status={status}
                  data-current={current || undefined}
                >
                  <span className={`status-dot status-dot--${status}`} aria-hidden="true" />
                  <div className="inbox-pane-session-text">
                    <span className="inbox-pane-session-label">
                      {sessionLabel(session)}
                      {session.automation && (
                        <span className="inbox-pane-automation-badge" title="Started by an automation, read-only">
                          {session.automation.name}
                        </span>
                      )}
                    </span>
                    <span className="inbox-pane-session-sub">
                      <span className="inbox-pane-session-status">{phase ?? STATUS_WORDS[status]}</span>
                      {' · '}
                      {formatAge(session.lastActiveAt)}
                      {session.cwd ? ` · ${basename(session.cwd)}` : ''}
                    </span>
                  </div>
                  {current ? (
                    <span className="inbox-pane-current">This session</span>
                  ) : (
                    <button
                      className="inbox-pane-open"
                      onClick={() => activateSession(workspace.id, session.id)}
                      aria-label={`Open ${sessionLabel(session)}`}
                    >
                      Open
                      <ArrowRight size={12} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="inbox-pane-launch">
          {/* The dock's own heading and the hairline above say it; a second
              visible heading was one more thing to read before the buttons. */}
          <h3 className="sr-only">Start a session</h3>
          {uncloned ? (
            <>
              <p className="inbox-pane-hint">
                {repoShort} is not cloned in any scope of this workspace.
              </p>
              <div className="inbox-pane-actions">
                <button
                  className="inbox-pane-action inbox-pane-action--default inbox-pane-clone"
                  disabled={launching[repoKey]}
                  data-launching={launching[repoKey] || undefined}
                  onClick={() => openClonePrompt(workspace.id, item)}
                >
                  <ActionIcon icon={launching[repoKey] ? LoaderCircle : FolderDown} spin={launching[repoKey]} />
                  {launching[repoKey] ? 'Cloning…' : 'Clone into scope…'}
                </button>
              </div>
              {launchErrors[repoKey] && (
                <p className="inbox-pane-action-error" role="alert">{launchErrors[repoKey]}</p>
              )}
            </>
          ) : (
            <>
              {actions.length === 0 && (
                <p className="inbox-pane-hint">
                  No actions apply to {item.workItem.type === 'pr' ? 'pull requests' : 'issues'} —
                  add one in Workspace settings.
                </p>
              )}
              <div className="inbox-pane-actions">
                {actions.map(({ action, key, automationReview }) => {
                  const confirming = confirmingKey === key;
                  const isDefault = highlighted?.id === action.id;
                  const pending = launching[key];
                  // A default starts something (a play mark); a button that
                  // opens an automation's finished review points away instead.
                  const icon = pending
                    ? LoaderCircle
                    : confirming
                      ? TriangleAlert
                      : automationReview
                        ? ArrowUpRight
                        : isDefault
                          ? Play
                          : null;
                  return (
                    <button
                      key={action.id}
                      className={[
                        'inbox-pane-action',
                        isDefault && 'inbox-pane-action--default',
                        confirming && 'inbox-pane-action--confirm',
                      ].filter(Boolean).join(' ')}
                      data-action-id={action.id}
                      data-launching={pending || undefined}
                      disabled={pending}
                      title={automationReview ? `Open the review ${automationReview.automation!.name} started` : undefined}
                      onClick={() =>
                        automationReview
                          ? activateSession(workspace.id, automationReview.id)
                          : start({ id: action.id }, key)
                      }
                    >
                      {icon && <ActionIcon icon={icon} spin={pending} filled={icon === Play} />}
                      {pending ? 'Preparing…' : confirming ? CONFIRM_LABEL : action.name}
                    </button>
                  );
                })}
                {!customOpen && (
                  <button
                    ref={customToggleRef}
                    className="inbox-pane-action inbox-pane-action--compose"
                    onClick={() => setCustomOpen(true)}
                  >
                    <ActionIcon icon={PenLine} />
                    Custom prompt…
                  </button>
                )}
              </div>
              {actions.map(({ action, key }) =>
                launchErrors[key] ? (
                  <p className="inbox-pane-action-error" role="alert" key={action.id}>
                    {actions.length > 1 && <strong>{action.name}: </strong>}
                    {launchErrors[key]}
                  </p>
                ) : null
              )}

              {customOpen && (
                <div ref={customBoxRef} className="inbox-pane-custom">
                  {landedKey !== null && (
                    <span
                      key={landedKey}
                      className="inbox-pane-custom-landed"
                      aria-hidden="true"
                      onAnimationEnd={() => setLandedKey(null)}
                    />
                  )}
                  <textarea
                    ref={customFieldRef}
                    className="inbox-pane-custom-textarea"
                    rows={3}
                    value={customPrompt}
                    onChange={(event) => setCustomPrompt(event.target.value)}
                    onKeyDown={onCustomKey}
                    placeholder="What should the agent do?"
                    aria-label="Custom prompt"
                    aria-keyshortcuts={MOD_KEY === '⌘' ? 'Meta+Enter' : 'Control+Enter'}
                    autoFocus
                  />
                  <div className="inbox-pane-placeholders" role="group" aria-label="Insert a placeholder">
                    <span className="inbox-pane-placeholders-label" aria-hidden="true">Insert</span>
                    {PLACEHOLDERS.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="inbox-pane-placeholder"
                        title={`Insert {{${name}}}, filled in when the session starts`}
                        // Keep the caret where it is: the insert goes there.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertPlaceholder(`{{${name}}}`)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <div className="inbox-pane-custom-actions">
                    <span className="inbox-pane-kbd-hint" aria-hidden="true">
                      <kbd>{MOD_KEY}</kbd><kbd>↵</kbd> start · <kbd>Esc</kbd> cancel
                    </span>
                    <button className="inbox-pane-action inbox-pane-action--quiet" onClick={closeCustom}>
                      Cancel
                    </button>
                    <button
                      className={`inbox-pane-action ${
                        confirmingKey === customKey ? 'inbox-pane-action--confirm' : 'inbox-pane-action--default'
                      }`}
                      data-action-id="custom"
                      data-launching={launching[customKey] || undefined}
                      disabled={!canStartCustom}
                      onClick={() => start({ customPrompt: trimmedCustom }, customKey)}
                    >
                      <ActionIcon
                        icon={launching[customKey] ? LoaderCircle : confirmingKey === customKey ? TriangleAlert : Play}
                        spin={launching[customKey]}
                        filled={!launching[customKey] && confirmingKey !== customKey}
                      />
                      {launching[customKey]
                        ? 'Preparing…'
                        : confirmingKey === customKey
                          ? CONFIRM_LABEL
                          : 'Start'}
                    </button>
                  </div>
                  {launchErrors[customKey] && (
                    <p className="inbox-pane-action-error" role="alert">{launchErrors[customKey]}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {workspace.provider && <WorkItemDetailPanel
        key={`${workspace.id}:${workspace.provider.accountLogin}:${workspace.provider.org ?? ''}`}
        workspaceId={workspace.id}
        accountLogin={workspace.provider.accountLogin}
        item={item}
        headSlot={detailHead}
        onDetails={setFetched}
        fixTarget={fixInSession ? 'this session' : 'a session'}
        onFix={fixInSession ?? receiveFix}
        onOpenWorkItem={onOpenWorkItem}
      />}
    </aside>
  );
}

function ActionIcon({ icon: Icon, spin, filled }: { icon: LucideIcon; spin?: boolean; filled?: boolean }) {
  return (
    <Icon
      size={13}
      aria-hidden="true"
      className={`inbox-pane-action-icon${spin ? ' inbox-pane-action-icon--spin' : ''}`}
      fill={filled ? 'currentColor' : 'none'}
    />
  );
}
