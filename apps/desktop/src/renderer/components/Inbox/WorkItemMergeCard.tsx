import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronRight, GitMerge, GitPullRequestDraft, TriangleAlert, UserRound, Wrench } from 'lucide-react';
import {
  MERGE_METHODS,
  OUTCOME_TONE,
  checkLabel,
  checkOutcome,
  mergeGate,
  mergeRefusal,
  mergeRows,
  sortChecks,
  summarizeChecks,
  type MergeMethod,
  type MergeRow,
} from './workItemDetailPresentation';
import { CheckIcon, Messages, TONE_ICONS, useWorkItemDetail } from './WorkItemDetailParts';

const METHOD_KEY = (workspaceId: string) => `consola.inbox.mergeMethod.${workspaceId}`;

/** The method last merged with in this workspace: a per-viewer convenience, so storage may say nothing. */
function rememberedMethod(workspaceId: string): MergeMethod {
  try {
    const stored = localStorage.getItem(METHOD_KEY(workspaceId));
    return stored && stored in MERGE_METHODS ? (stored as MergeMethod) : 'squash';
  } catch {
    return 'squash';
  }
}

function remember(workspaceId: string, method: MergeMethod) {
  try {
    localStorage.setItem(METHOD_KEY(workspaceId), method);
  } catch {
    // Remembering is a nicety; the merge itself does not depend on it.
  }
}

function RowView({ row, id, action, children }: { row: MergeRow; id: string; action?: ReactNode; children?: ReactNode }) {
  const Icon = row.key === 'draft' ? GitPullRequestDraft : TONE_ICONS[row.tone];
  return (
    <div className="inbox-detail-merge-row" data-key={row.key}>
      <Icon size={16} className="inbox-detail-tone-icon" data-tone={row.tone} aria-hidden="true" />
      <div className="inbox-detail-merge-row-text" id={id}>
        <strong>{row.title}</strong>
        <span>{row.detail}</span>
        {children}
      </div>
      {action && <div className="inbox-detail-merge-row-action">{action}</div>}
    </div>
  );
}

/**
 * The end of an open pull request, as GitHub ends its page: one row per
 * thing in the way of a merge (reviews, checks, the branch), then the
 * merge. `mergeGate` alone decides the merge button's colour and whether it
 * can be pressed, so it never promises a merge GitHub would refuse.
 */
export function MergeCard({ onAddReview }: { onAddReview: () => void }) {
  const { workspaceId, ref, details, accountLogin, ownItem, open, busy, perform, handOff, item, fixTarget } = useWorkItemDetail();
  const uid = useId();
  const rows = mergeRows(details);
  const gate = mergeGate(details.mergeState);
  const summary = summarizeChecks(details.checks);
  const [checksOpen, setChecksOpen] = useState(summary.failing > 0);
  const [method, setMethod] = useState<MergeMethod>(() => rememberedMethod(workspaceId));
  const [confirm, setConfirm] = useState<'merge' | 'auto-merge' | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const pending = details.pendingReview;

  // Opening a confirmation moves focus into it, so Enter and Escape act on it.
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);

  const dismiss = () => {
    setConfirm(null);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const ask = (kind: 'merge' | 'auto-merge', trigger: HTMLElement) => {
    returnFocus.current = trigger;
    setConfirm(kind);
  };
  const choose = (next: MergeMethod) => {
    setMethod(next);
    remember(workspaceId, next);
  };

  const refusal = details.isDraft ? '' : mergeRefusal(rows, gate, details.mergeState, details.baseBranch);
  // A disabled button shows no tooltip of its own: the rows in its way describe it.
  const describedBy = [
    ...rows.filter((row) => row.blocking && row.tone !== 'success').map((row) => `${uid}-${row.key}`),
    ...(refusal ? [`${uid}-refusal`] : []),
  ].join(' ') || undefined;
  const warning = rows.filter((row) => row.blocking && row.tone !== 'success').map((row) => row.title).join(' · ');
  // Re-checked at confirm time: a refresh may have changed the answer since.
  const allowed = confirm === 'merge' ? gate.button !== 'disabled' : confirm === 'auto-merge' ? gate.canQueue : false;
  const go = confirm === 'auto-merge' || (confirm === 'merge' && gate.button === 'go');

  const reviewAction = pending ? (
    <button type="button" className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--solid inbox-detail-btn--accent" onClick={onAddReview}>
      Finish your review
    </button>
  ) : !ownItem ? (
    <button type="button" className="inbox-detail-btn inbox-detail-btn--small" onClick={onAddReview}>
      Add your review
    </button>
  ) : null;

  return (
    <section className="inbox-detail-card inbox-detail-merge-card" aria-label="Merge">
      {rows.map((row) => {
        const id = `${uid}-${row.key}`;
        if (row.key === 'reviews') {
          return (
            <RowView key={row.key} row={row} id={id} action={reviewAction}>
              {pending && (
                <span className="inbox-detail-toned" data-tone="warning">
                  Your review is pending · {pending.commentCount} comment{pending.commentCount === 1 ? '' : 's'}
                </span>
              )}
            </RowView>
          );
        }
        if (row.key === 'checks') {
          return (
            <div key={row.key} className="inbox-detail-merge-group">
              <RowView
                row={row}
                id={id}
                action={(
                  <button
                    type="button"
                    className="inbox-detail-icon-btn"
                    aria-expanded={checksOpen}
                    aria-controls={`${uid}-checks`}
                    aria-label={checksOpen ? 'Hide checks' : 'Show checks'}
                    title={checksOpen ? 'Hide checks' : 'Show checks'}
                    onClick={() => setChecksOpen(!checksOpen)}
                  >
                    <ChevronRight size={15} className="inbox-detail-chevron" data-open={checksOpen || undefined} aria-hidden="true" />
                  </button>
                )}
              />
              {checksOpen && (
                <div id={`${uid}-checks`} className="inbox-detail-merge-checks">
                  <ul className="inbox-detail-checklist">
                    {sortChecks(details.checks).map((check, index) => {
                      const outcome = checkOutcome(check.state);
                      return (
                        <li className="inbox-detail-check" key={`${check.name}:${index}`}>
                          <CheckIcon outcome={outcome} />
                          <span className="inbox-detail-check-name">
                            {check.url ? (
                              <a className="inbox-detail-text-link" href={check.url} target="_blank" rel="noreferrer">{check.name}</a>
                            ) : (
                              check.name
                            )}
                          </span>
                          <span className="inbox-detail-check-state inbox-detail-toned" data-tone={OUTCOME_TONE[outcome]}>{checkLabel(check.state)}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {open && summary.failing > 0 && (
                    <button
                      type="button"
                      className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--tinted"
                      data-tone="accent"
                      onClick={() => handOff(
                        `Investigate and fix the failing CI checks for ${item.url}. Read the check logs, implement fixes, and run the relevant validation before pushing.`,
                        'merge'
                      )}
                    >
                      <Wrench size={13} aria-hidden="true" />
                      Fix failing checks in {fixTarget}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        }
        if (row.key === 'branch') {
          const update = details.mergeState === 'BEHIND' && details.canUpdateBranch;
          return (
            <RowView
              key={row.key}
              row={row}
              id={id}
              action={update ? (
                <button
                  type="button"
                  className="inbox-detail-btn inbox-detail-btn--small"
                  disabled={busy}
                  onClick={() => void perform({ kind: 'update-branch' }, 'Branch updated.', 'merge')}
                >
                  Update branch
                </button>
              ) : undefined}
            />
          );
        }
        return (
          <RowView
            key={row.key}
            row={row}
            id={id}
            action={(
              <button
                type="button"
                className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--solid inbox-detail-btn--accent"
                disabled={busy}
                onClick={() => void perform({ kind: 'ready', draft: false }, 'Ready for review.', 'merge')}
              >
                Ready for review
              </button>
            )}
          />
        );
      })}

      {!details.isDraft && (
        <div className="inbox-detail-merge-foot">
          {refusal && (
            <p id={`${uid}-refusal`} className="inbox-detail-merge-note">
              <TriangleAlert size={13} className="inbox-detail-tone-icon" data-tone="warning" aria-hidden="true" />
              {refusal}
            </p>
          )}
          <div className="inbox-detail-merge-actions">
            <div className="inbox-detail-split" data-go={gate.button === 'go' || undefined}>
              <button
                type="button"
                className={`inbox-detail-btn ${gate.button === 'go' ? 'inbox-detail-btn--solid inbox-detail-btn--success' : ''}`}
                disabled={busy || !details.headOid || gate.button === 'disabled'}
                aria-expanded={confirm === 'merge'}
                aria-describedby={describedBy}
                onClick={(event) => ask('merge', event.currentTarget)}
              >
                <GitMerge size={14} aria-hidden="true" />
                {MERGE_METHODS[method]}
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild disabled={busy}>
                  <button
                    type="button"
                    className={`inbox-detail-btn inbox-detail-split-caret ${gate.button === 'go' ? 'inbox-detail-btn--solid inbox-detail-btn--success' : ''}`}
                    aria-label="Merge method"
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="dropdown-content" sideOffset={4} align="start">
                    <DropdownMenu.RadioGroup value={method} onValueChange={(value) => choose(value as MergeMethod)}>
                      {(Object.keys(MERGE_METHODS) as MergeMethod[]).map((key) => (
                        <DropdownMenu.RadioItem key={key} value={key} className="dropdown-item">
                          <span className="inbox-detail-menu-check">
                            <DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
                          </span>
                          <span>{MERGE_METHODS[key]}</span>
                        </DropdownMenu.RadioItem>
                      ))}
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            {gate.canQueue && (
              <button
                type="button"
                className="inbox-detail-btn"
                disabled={busy || !details.headOid}
                aria-expanded={confirm === 'auto-merge'}
                onClick={(event) => ask('auto-merge', event.currentTarget)}
              >
                Enable auto-merge…
              </button>
            )}
            <span className="inbox-detail-account" title="Actions here run as this workspace’s GitHub account">
              <UserRound size={12} aria-hidden="true" />
              as {accountLogin}
            </span>
          </div>
        </div>
      )}

      {confirm && (
        <div
          className="inbox-detail-confirm"
          data-tone={go ? 'success' : 'neutral'}
          role="group"
          aria-label={`Confirm ${confirm}`}
          onKeyDown={(event) => {
            // Handled here, so the Inbox's own Esc does not close the whole pane.
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              dismiss();
            }
          }}
        >
          <p className="inbox-detail-confirm-title">
            <GitMerge size={15} aria-hidden="true" />
            {confirm === 'auto-merge'
              ? `Merge pull request #${ref.number} into ${details.baseBranch} once it can be?`
              : `Merge pull request #${ref.number} into ${details.baseBranch}?`}
          </p>
          {warning && (
            <p className="inbox-detail-confirm-warning" data-tone="warning">
              <TriangleAlert size={14} aria-hidden="true" />
              {warning}
            </p>
          )}
          <p className="inbox-detail-hint">
            {MERGE_METHODS[method]}.{' '}
            {confirm === 'auto-merge'
              ? 'GitHub merges it as soon as every requirement passes, if the repository allows auto-merge.'
              : 'GitHub enforces repository rules and supported merge methods.'}
          </p>
          <div className="inbox-detail-form-foot">
            <button type="button" className="inbox-detail-btn inbox-detail-btn--quiet" disabled={busy} onClick={dismiss}>Cancel</button>
            <button
              ref={confirmButton}
              type="button"
              className={`inbox-detail-btn ${go ? 'inbox-detail-btn--solid inbox-detail-btn--success' : ''}`}
              disabled={busy || !allowed}
              onClick={() => {
                const auto = confirm === 'auto-merge';
                void perform(
                  { kind: 'merge', method, auto, headOid: details.headOid! },
                  auto ? 'Auto-merge requested.' : 'Merge requested.',
                  'merge'
                ).then((ok) => ok && setConfirm(null));
              }}
            >
              {busy ? 'Working…' : confirm === 'auto-merge' ? 'Enable auto-merge' : 'Confirm merge'}
            </button>
          </div>
        </div>
      )}
      <Messages at="merge" />
    </section>
  );
}
