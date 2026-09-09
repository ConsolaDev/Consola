import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import {
  WORKSPACE_EMOJIS, WORKSPACE_SYMBOLS, isWorkspaceImageIcon,
  type WorkspaceIconValue, type WorkspaceImageIcon,
} from '../../../shared/workspaceIcons';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { prepareWorkspaceIcon } from '../../utils/workspaceIconUpload';

function initialTab(icon: WorkspaceIconValue | undefined): string {
  if (isWorkspaceImageIcon(icon)) return 'upload';
  return typeof icon === 'string' && icon.startsWith('emoji-') ? 'emoji' : 'icons';
}

/** Uses the same dialog primitive as its parent so nested focus and Escape stay coordinated. */
export function WorkspaceIconPicker({ workspace }: { workspace: Workspace }) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState(() => initialTab(workspace.icon));
  const [draftImage, setDraftImage] = useState<WorkspaceImageIcon | null>(null);
  const [fileName, setFileName] = useState('');
  const [preparing, setPreparing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef(0);
  const busy = saving || preparing;

  const upload = async (file: File) => {
    const request = ++uploadRequest.current;
    setPreparing(true);
    setError(null);
    setDraftImage(null);
    setFileName('');
    try {
      const image = await prepareWorkspaceIcon(file);
      if (request !== uploadRequest.current) return;
      setDraftImage(image);
      setFileName(file.name);
    } catch (cause) {
      if (request === uploadRequest.current) {
        setError(cause instanceof Error ? cause.message : 'Could not open this image.');
      }
    } finally {
      if (request === uploadRequest.current) setPreparing(false);
    }
  };

  const choose = async (icon: WorkspaceIconValue | undefined) => {
    if (busy) return;
    setSaving(true);
    setError(null);
    try {
      await updateWorkspace(workspace.id, { icon });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the workspace icon.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ws-icon-anchor">
      <Dialog.Root open={open} onOpenChange={(next) => {
        setOpen(next);
        uploadRequest.current++;
        setPreparing(false);
        if (next) {
          setQuery(''); setError(null); setDraftImage(null); setFileName('');
          setTab(initialTab(workspace.icon));
        }
      }}>
        <Dialog.Trigger asChild>
          <button type="button" className="ws-icon-trigger" aria-label="Change workspace icon" title="Change workspace icon">
            <WorkspaceIcon icon={workspace.icon} size={28} />
          </button>
        </Dialog.Trigger>
        <Dialog.Content className="ws-icon-picker" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Workspace icon</Dialog.Title>
          {tab !== 'upload' && <input
            className="ws-icon-search"
            type="search"
            aria-label="Search workspace icons"
            placeholder="Search icons…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />}
          <Tabs.Root value={tab} onValueChange={setTab}>
            <Tabs.List className="ws-icon-tabs" aria-label="Icon style">
              <Tabs.Trigger value="emoji">Emojis</Tabs.Trigger>
              <Tabs.Trigger value="icons">Icons</Tabs.Trigger>
              <Tabs.Trigger value="upload">Upload</Tabs.Trigger>
            </Tabs.List>
            {(['emoji', 'icons'] as const).map((tab) => {
              const choices = (tab === 'emoji' ? WORKSPACE_EMOJIS : WORKSPACE_SYMBOLS)
                .filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()));
              return (
                <Tabs.Content key={tab} value={tab}>
                  <div className="ws-icon-grid" role="group" aria-label={tab === 'emoji' ? 'Emojis' : 'Icons'}>
                    {choices.map(([id, label]) => (
                      <button
                        type="button" key={id} className="ws-icon-choice"
                        aria-label={label} title={label}
                        aria-pressed={(workspace.icon ?? 'layout') === id}
                        disabled={busy} onClick={() => void choose(id)}
                      >
                        <WorkspaceIcon icon={id} size={22} />
                      </button>
                    ))}
                  </div>
                  {choices.length === 0 && <p className="ws-panel-hint ws-icon-empty">No icons found.</p>}
                </Tabs.Content>
              );
            })}
            <Tabs.Content value="upload" className="ws-icon-upload">
              <div className="ws-icon-upload-preview" aria-label="Image preview">
                <WorkspaceIcon icon={draftImage ?? workspace.icon} size={64} />
              </div>
              <p className="ws-panel-hint">
                Upload your own logo or image. PNG, JPG, WebP, or GIF, up to 5 MB.
                GIFs use a still image.
              </p>
              <input ref={fileInput} type="file" className="sr-only"
                aria-label="Upload workspace image" accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={busy} tabIndex={-1}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void upload(file);
                }} />
              <button type="button" className="dialog-button-secondary" disabled={busy}
                onClick={() => fileInput.current?.click()}>
                {preparing ? 'Preparing image…' : draftImage || isWorkspaceImageIcon(workspace.icon) ? 'Replace image…' : 'Choose image…'}
              </button>
              {draftImage && <>
                <p className="ws-icon-filename" title={fileName}>{fileName}</p>
                <button type="button" className="dialog-button-primary" disabled={busy}
                  onClick={() => void choose(draftImage)}>
                  {saving ? 'Saving…' : 'Use image'}
                </button>
              </>}
            </Tabs.Content>
          </Tabs.Root>
          {error && <p className="ws-icon-error" role="alert">{error}</p>}
          <button type="button" className="ws-icon-reset" disabled={busy || workspace.icon === undefined} onClick={() => void choose(undefined)}>
            Reset to default
          </button>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
