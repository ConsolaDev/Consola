import { useEffect, useState } from 'react';
import { Check, ChevronDown, Folder, GitBranch, GitFork, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import type { CheckoutContext, SessionCheckout } from '../../../shared/sessionCheckout';
import type { Scope } from '../../../shared/workspace';

interface Props {
  workspaceId: string;
  scope: Scope;
  value: SessionCheckout;
  onChange: (value: SessionCheckout) => void;
  disabled: boolean;
}

export function CheckoutPicker({ workspaceId, scope, value, onChange, disabled }: Props) {
  const [context, setContext] = useState<CheckoutContext>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showTrees, setShowTrees] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!scope.isGitRepo) return;
    setLoading(true);
    setError('');
    window.workspaceAPI.checkoutContext(workspaceId, scope.id)
      .then(result => { if (!cancelled) setContext(result); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, scope.id, scope.isGitRepo, revision]);

  const tree = value.mode === 'existing' ? context?.worktrees.find(item => item.path === value.path) : undefined;
  const label = value.mode === 'new' ? value.baseRef : tree?.branch ?? (tree ? `Detached · ${tree.head.slice(0, 7)}` : context?.branch ?? 'HEAD');
  const needle = query.toLowerCase();
  const trees = context?.worktrees.filter(item => `${item.branch ?? ''} ${item.path}`.toLowerCase().includes(needle)) ?? [];
  const refs = context?.refs.filter(ref => ref.toLowerCase().includes(needle)) ?? [];
  const choose = (next: SessionCheckout) => { onChange(next); setOpen(false); };
  const chooseRef = (ref: string) => {
    if (value.mode === 'new') {
      choose({ ...value, baseRef: ref, useExistingBranch: false });
      return;
    }
    const existing = context?.worktrees.find(item => item.branch === ref && !item.unavailable);
    if (existing) {
      choose(existing.current ? { mode: 'current' } : { mode: 'existing', path: existing.path });
      return;
    }
    choose({ mode: 'new', baseRef: ref, useExistingBranch: context?.localBranches.includes(ref) ?? false });
  };


  return <>
    <div className="checkout-strip">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button className="composer-control checkout-mode" disabled={disabled || !scope.isGitRepo} aria-label="Checkout mode">
            {value.mode === 'current' ? <Folder size={14} /> : <GitFork size={14} />}
            <span>{value.mode === 'current' ? 'Current checkout' : value.mode === 'new' ? 'New worktree' : 'Existing worktree'}</span>
            {scope.isGitRepo && <ChevronDown size={12} />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content checkout-mode-menu" side="top" align="start" sideOffset={8} onCloseAutoFocus={event => { if (open) event.preventDefault(); }}>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => onChange({ mode: 'current' })}>
              <Folder size={16} /><span>Current checkout<small>Work in this folder as it is</small></span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => onChange({ mode: 'new', baseRef: context?.branch ?? 'HEAD' })}>
              <Plus size={16} /><span>New worktree<small>Start in a separate working folder</small></span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => { setShowTrees(true); setQuery(''); setRevision(n => n + 1); setOpen(true); }}>
              <GitFork size={16} /><span>Existing worktree<small>Continue in a checkout you already have</small></span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {scope.isGitRepo && <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setQuery(''); setShowTrees(value.mode === 'existing'); setRevision(n => n + 1); } }}>
        <Popover.Trigger asChild>
          <button className="composer-control checkout-ref" aria-label={value.mode === 'new' ? 'Base branch' : 'Choose branch or worktree'} disabled={disabled} title={tree?.path ?? scope.path}>
            {loading ? <Loader2 size={13} className="composer-spinner" /> : <GitBranch size={13} />}
            {value.mode === 'new' && <span className="checkout-from">from</span>}<span>{label}</span><ChevronDown size={12} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="checkout-popover" side="top" align="end" sideOffset={8} aria-label="Branches and worktrees">
            <div className="checkout-search"><Search size={15} /><input aria-label="Search branches and worktrees" placeholder="Search branches and worktrees…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('.checkout-popover')?.querySelector<HTMLButtonElement>('.checkout-results button:not(:disabled)')?.focus(); }
            }} /><button aria-label="Refresh branches and worktrees" className="composer-control" onClick={() => setRevision(n => n + 1)} disabled={loading}><RefreshCw size={13} /></button></div>
            <div className="checkout-tabs"><button aria-pressed={!showTrees} onClick={() => setShowTrees(false)}>Branches</button><button aria-pressed={showTrees} onClick={() => setShowTrees(true)}>Worktrees <span>{context?.worktrees.length ?? 0}</span></button></div>
            <div className="checkout-results" onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              event.preventDefault(); buttons[next]?.focus();
            }}>
              {error ? <div className="checkout-empty" role="alert">{error}</div> : loading && !context ? <div className="checkout-empty" role="status">Loading checkouts…</div> : <>
                {showTrees ? trees.map(item => <button key={item.path} className="checkout-result" disabled={item.unavailable} title={item.path} onClick={() => choose(item.current ? { mode: 'current' } : { mode: 'existing', path: item.path })}>
                  <GitFork size={14} /><span className="checkout-result-text"><span>{item.branch ?? `Detached · ${item.head.slice(0, 7)}`}</span><small>{item.path}</small></span><span className="checkout-badge">{item.unavailable ? 'missing' : item.current ? 'current' : 'worktree'}</span>
                </button>) : refs.map(ref => {
                  const existing = context?.worktrees.find(item => item.branch === ref && !item.unavailable);
                  return <button key={ref} className="checkout-result" onClick={() => chooseRef(ref)}>
                    <GitBranch size={14} /><span className="checkout-result-text">{ref}</span>{label === ref && <Check size={13} />}<span className="checkout-badge">{existing?.current ? 'current' : existing ? 'worktree' : ''}</span>
                  </button>;
                })}
                {(showTrees ? trees : refs).length === 0 && <div className="checkout-empty">{query ? 'No matching branches or worktrees.' : showTrees ? 'No worktrees available.' : 'No branches yet. Make an initial commit to create a worktree.'}</div>}
              </>}
            </div>
            <div className="checkout-popover-hint">{value.mode === 'new' ? 'Choose the starting point for your new worktree.' : 'Branches open in an existing or a new worktree.'}</div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>}
    </div>
    {value.mode === 'new' && <div className="checkout-new-details">
      <GitBranch size={14} /><label htmlFor="new-worktree-branch">{value.useExistingBranch ? 'Branch' : 'New branch'}</label>
      <input id="new-worktree-branch" placeholder="Auto-generated, or enter a name" value={value.useExistingBranch ? value.baseRef : value.branchName ?? ''} disabled={disabled || value.useExistingBranch} onChange={event => onChange({ ...value, branchName: event.target.value })} />
      <span>Created when you send</span>
    </div>}
    {value.mode === 'existing' && tree && <p className="checkout-path" title={tree.path}>{tree.path}</p>}
  </>;
}
