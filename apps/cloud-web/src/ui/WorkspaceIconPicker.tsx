import { Popover, Tabs } from '@radix-ui/themes';
import { useState } from 'react';
import { messageForIconFailure } from '../domain/messages';
import type { MyWorkspace } from '../domain/workspace';
import {
  iconsMatching,
  WORKSPACE_EMOJIS,
  WORKSPACE_SYMBOLS,
  type WorkspaceIcon as Icon,
} from '../domain/workspaceIcons';
import { setWorkspaceIcon } from '../services/api';
import { useSettingsMenuHost } from './SettingsDialog';
import { WorkspaceIcon } from './WorkspaceIcon';

type Tab = 'emoji' | 'icons';

/** The tab the picker opens on: the one holding the icon worn, else Icons, as the desktop does. */
const tabFor = (icon: Icon | null): Tab => (icon?.startsWith('emoji-') ? 'emoji' : 'icons');

/**
 * The workspace's icon, and the picker that changes it, as the desktop app's
 * (`WorkspaceSettings/WorkspaceIconPicker.tsx`): a tile that opens a search over Emojis and Icons,
 * and Reset to default, which takes the icon off. Picking one sets it at once
 * (`setWorkspaceIcon`), then `onChanged` loads the page again so the sidebar wears it too. Only
 * someone the server says may manage the workspace gets the picker; anyone else sees the tile.
 */
export function WorkspaceIconPicker({
  workspace,
  onChanged,
}: {
  workspace: MyWorkspace;
  onChanged: () => Promise<void>;
}) {
  const host = useSettingsMenuHost();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>(() => tabFor(workspace.icon));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const tile = (
    // Keyed by the icon, so a new one arrives with the tile's pop.
    <WorkspaceIcon
      key={workspace.icon ?? 'none'}
      icon={workspace.icon}
      name={workspace.name}
      size={26}
    />
  );

  if (!workspace.canManage) {
    return (
      <span ref={host.ref} className="icon-picker-tile">
        {tile}
      </span>
    );
  }

  async function choose(icon: Icon | null) {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const answer = await setWorkspaceIcon(icon);
    if (answer.kind === 'changed' || answer.kind === 'signed-out') {
      // Signed out shows the sign-in card once the page loads again.
      await onChanged();
      setOpen(false);
    } else {
      setFailure(messageForIconFailure(answer));
    }
    setSaving(false);
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setFailure(null);
          setTab(tabFor(workspace.icon));
        }
      }}
    >
      <Popover.Trigger>
        <button
          ref={host.ref}
          type="button"
          className="icon-picker-tile"
          aria-label="Change workspace icon"
          title="Change workspace icon"
        >
          {tile}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="icon-picker"
        align="start"
        container={host.container}
        aria-label="Workspace icon"
      >
        <input
          className="icon-picker-search"
          type="search"
          aria-label="Search workspace icons"
          placeholder="Search icons…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <Tabs.List size="1" aria-label="Icon style">
            <Tabs.Trigger value="emoji">Emojis</Tabs.Trigger>
            <Tabs.Trigger value="icons">Icons</Tabs.Trigger>
          </Tabs.List>
          {(['emoji', 'icons'] as const).map((each) => {
            const choices = iconsMatching<readonly [Icon, string, ...string[]]>(
              each === 'emoji' ? WORKSPACE_EMOJIS : WORKSPACE_SYMBOLS,
              query,
            );
            return (
              <Tabs.Content key={each} value={each}>
                {choices.length > 0 ? (
                  <div className="icon-picker-grid">
                    {choices.map(([id, label]) => (
                      <button
                        type="button"
                        key={id}
                        className="icon-picker-choice"
                        aria-label={label}
                        title={label}
                        aria-pressed={workspace.icon === id}
                        disabled={saving}
                        onClick={() => void choose(id)}
                      >
                        <WorkspaceIcon icon={id} size={20} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="icon-picker-empty">No icons match “{query.trim()}”.</p>
                )}
              </Tabs.Content>
            );
          })}
        </Tabs.Root>
        {failure && (
          <p className="icon-picker-error" role="alert">
            {failure}
          </p>
        )}
        <button
          type="button"
          className="icon-picker-reset"
          disabled={saving || workspace.icon === null}
          onClick={() => void choose(null)}
        >
          Reset to default
        </button>
      </Popover.Content>
    </Popover.Root>
  );
}
