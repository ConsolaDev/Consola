import { useEffect, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Folder, FolderGit2, GitBranch } from 'lucide-react';
import { checkoutRef, type CheckoutInfo } from '../../../shared/sessionCheckout';
import { tildePath } from '../../utils/displayPath';
import { basename } from '../../utils/fileUtils';

/** How long "Copied" stays up before the tooltip goes back to explaining. */
const COPIED_MS = 1500;

/**
 * Where the session's edits land, right after its name.
 *
 * A repository's own checkout reads as a quiet branch, since that is what
 * most sessions run in. A linked worktree adds a labelled segment in its own
 * hue, so a session working apart from the folder you opened says so before
 * anything else in the header. Both show the branch behind a branch glyph:
 * a worktree is a folder, and the name beside it is what that folder has
 * checked out, not what the folder is called.
 *
 * The tooltip spells out the three things people mix up — the branch, the
 * worktree's folder, and the main checkout it belongs to — as labelled rows,
 * because the folder name is generated and never matches the branch.
 *
 * Clicking copies the folder's path: the next thing anyone does with a
 * worktree is usually `cd` into it from somewhere else.
 */
export function CheckoutChip({ checkout }: { checkout: CheckoutInfo | undefined }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!checkout || checkout.kind === 'none') return null;

  const isWorktree = checkout.kind === 'worktree';
  const ref = checkoutRef(checkout);
  const spokenRef = checkout.branch ? `branch ${checkout.branch}` : `detached at ${checkout.head ?? 'HEAD'}`;

  const handleCopy = () => {
    navigator.clipboard.writeText(checkout.root).then(
      () => {
        setCopied(true);
        // The trigger's own pointer-down closes the tooltip; reopen it so the
        // confirmation is seen where the click happened.
        setOpen(true);
      },
      () => {
        // Clipboard refused (no focus); the tooltip keeps offering the copy.
      }
    );
  };

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="checkout-chip"
            data-kind={checkout.kind}
            onClick={handleCopy}
            aria-label={`${isWorktree ? 'Worktree' : 'Main checkout'}, ${spokenRef}. Copy folder path`}
          >
            {isWorktree && (
              <span className="checkout-chip-kind">
                <FolderGit2 size={12} aria-hidden="true" />
                Worktree
              </span>
            )}
            <GitBranch size={12} className="checkout-chip-icon" aria-hidden="true" />
            <span className="checkout-chip-ref">{ref}</span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content checkout-tooltip" sideOffset={6} align="start">
            <span className="checkout-tooltip-title" data-kind={checkout.kind}>
              {isWorktree ? 'Worktree' : 'Main checkout'}
            </span>
            <p className="checkout-tooltip-lead">
              {isWorktree ? (
                <>
                  A second working folder for <strong>{basename(checkout.mainCheckout)}</strong>, on its
                  own branch. Edits here don't change the files in your main checkout.
                </>
              ) : (
                <>This session works directly in the folder you opened, not in a worktree.</>
              )}
            </p>
            <dl className="checkout-tooltip-facts">
              <dt>Branch</dt>
              <dd>
                <span className="checkout-tooltip-value">
                  <GitBranch size={12} aria-hidden="true" />
                  {checkout.branch ?? `none, detached at ${checkout.head ?? 'HEAD'}`}
                </span>
              </dd>
              <dt>Folder</dt>
              <dd>
                <span className="checkout-tooltip-value" data-kind={checkout.kind}>
                  {isWorktree ? <FolderGit2 size={12} aria-hidden="true" /> : <Folder size={12} aria-hidden="true" />}
                  {tildePath(checkout.root)}
                </span>
                {isWorktree && (
                  <span className="checkout-tooltip-note">
                    Named by Consola, not after the branch, which can change inside it.
                  </span>
                )}
              </dd>
              {isWorktree && (
                <>
                  <dt>Main checkout</dt>
                  <dd>
                    <span className="checkout-tooltip-value">
                      <Folder size={12} aria-hidden="true" />
                      {tildePath(checkout.mainCheckout)}
                    </span>
                    <span className="checkout-tooltip-note">
                      The folder you opened. Same repository: it shares commits and branches with this
                      worktree.
                    </span>
                  </dd>
                </>
              )}
            </dl>
            <span className="checkout-tooltip-hint" data-copied={copied || undefined}>
              {copied ? 'Copied the folder path' : 'Click to copy the folder path'}
            </span>
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
