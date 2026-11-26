import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { driverDefaultTitleModel } from '../../../shared/constants';
import {
  reconcileTitleSettings,
  resolveTitleSource,
  shownTitleEffort,
  titleHarnesses,
  titleSettingsOf,
} from '../../../shared/sessionTitles';
import type { SessionTitleSettings } from '../../../shared/workspace';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';
import { useHarnessStore } from '../../stores/harnessStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import type { Workspace } from '../../stores/workspaceStore';
import { TitleModelMenu } from './TitleModelMenu';

interface SessionTitlesPanelProps {
  workspace: Workspace;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Which model writes this workspace's session titles, and how. A choice that
 * cannot run is kept and explained, never swapped for another harness. The
 * default harness it can follow is chosen in General.
 */
export function SessionTitlesPanel({ workspace }: SessionTitlesPanelProps) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const statuses = useHarnessStore((state) => state.statuses);
  const settings = titleSettingsOf(workspace);
  const source = resolveTitleSource(workspace, harnesses);

  const defaultHarness = harnesses.find((h) => h.id === workspace.defaultHarnessId);
  const resolvedHarness =
    source.kind === 'ready'
      ? source.harness
      : settings.source === 'pinned'
        ? harnesses.find((h) => h.id === settings.harnessId)
        : defaultHarness;
  const { capabilities } = useHarnessCapabilities(
    source.kind === 'ready' ? source.harness : undefined,
    true,
  );
  const modelValue =
    source.kind === 'ready'
      ? source.model
      : settings.source === 'pinned'
        ? settings.model
        : undefined;
  const info = capabilities?.models.find((model) => model.value === modelValue);

  const save = (next: SessionTitleSettings) =>
    void updateWorkspace(workspace.id, { sessionTitles: next });

  const driverDefault = resolvedHarness
    ? driverDefaultTitleModel(resolvedHarness.driverId)
    : undefined;
  const chipLabel =
    settings.source === 'off'
      ? 'Off'
      : (info?.displayName ??
        modelValue ??
        (driverDefault ? `Default (${driverDefault})` : 'Unavailable'));

  const supportsEffort = info?.supportsEffort === true;
  const supportsFast = info?.supportsFastMode === true;
  // Display only: an effort the model does not offer reads, and is checked, as
  // Default. Nothing is written.
  const effort = info ? shownTitleEffort(settings, info) : 'default';
  const effortLabel = [
    supportsEffort ? capitalise(effort) : undefined,
    supportsFast && settings.fast ? 'Fast' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  let skipped: string | undefined;
  if (source.kind === 'unavailable') skipped = source.reason;
  else if (source.kind === 'ready' && statuses[source.harness.id]?.state === 'error') {
    skipped = `${source.harness.name} isn’t available.`;
  }

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Text generation</h3>
      </div>
      <div className="ws-card">
        <div className="ws-card-row ws-card-row--stacked">
          <div className="ws-card-row-main">
            <span className="ws-card-label">Text generation model</span>
            <div className="ws-card-chips">
              <TitleModelMenu
                settings={settings}
                harnesses={titleHarnesses(harnesses)}
                defaultHarness={defaultHarness}
                resolvedHarness={resolvedHarness}
                label={chipLabel}
                isOff={settings.source === 'off'}
                onChange={save}
              />
              {info && (supportsEffort || supportsFast) && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="ws-chip-trigger"
                      aria-label="Text generation effort"
                    >
                      <span className="ws-chip-trigger-label">{effortLabel || 'Default'}</span>
                      <ChevronDown size={12} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="dropdown-content ws-settings-menu"
                      sideOffset={6}
                      align="end"
                    >
                      {supportsEffort && (
                        <DropdownMenu.RadioGroup
                          value={effort}
                          onValueChange={(value) =>
                            save(reconcileTitleSettings({ ...settings, effort: value }, info))
                          }
                        >
                          {['default', ...(info.supportedEffortLevels ?? [])].map((level) => (
                            <DropdownMenu.RadioItem
                              key={level}
                              value={level}
                              className="dropdown-item"
                            >
                              <span className="ws-menu-indicator" aria-hidden="true">
                                <DropdownMenu.ItemIndicator>
                                  <Check size={12} />
                                </DropdownMenu.ItemIndicator>
                              </span>
                              <span>{capitalise(level)}</span>
                            </DropdownMenu.RadioItem>
                          ))}
                        </DropdownMenu.RadioGroup>
                      )}
                      {supportsFast && (
                        <>
                          {supportsEffort && (
                            <DropdownMenu.Separator className="dropdown-separator" />
                          )}
                          <DropdownMenu.CheckboxItem
                            className="dropdown-item"
                            checked={settings.fast === true}
                            onCheckedChange={(checked) => {
                              const next = { ...settings };
                              if (checked === true) next.fast = true;
                              else delete next.fast;
                              save(next);
                            }}
                          >
                            <span className="ws-menu-indicator" aria-hidden="true">
                              <DropdownMenu.ItemIndicator>
                                <Check size={12} />
                              </DropdownMenu.ItemIndicator>
                            </span>
                            <span>Fast</span>
                          </DropdownMenu.CheckboxItem>
                        </>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          </div>
          <p className="ws-panel-hint">
            For session titles and other generated text. Each new session&apos;s first message (up
            to 8,000 characters) is sent to it.
          </p>
          {skipped && (
            <p className="ws-panel-hint ws-panel-hint--warning" role="status">
              Titles are skipped: {skipped}
            </p>
          )}
        </div>

        <Collapsible.Root className="ws-card-advanced">
          <Collapsible.Trigger className="ws-card-advanced-trigger">
            <ChevronRight size={14} className="ws-card-advanced-chevron" />
            <span>Advanced</span>
          </Collapsible.Trigger>
          <Collapsible.Content>
            <InstructionsField settings={settings} onSave={save} />
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    </section>
  );
}

function InstructionsField({
  settings,
  onSave,
}: {
  settings: SessionTitleSettings;
  onSave: (next: SessionTitleSettings) => void;
}) {
  const stored = settings.instructions ?? '';
  const [draft, setDraft] = useState(stored);
  // The instructions last saved, or last read from the record. A save compares
  // against this rather than `stored`, which lags until the write comes back,
  // so the unmount that follows a blur never saves the same draft again.
  const savedRef = useRef(stored);
  // Follow the record when it changes from elsewhere, e.g. another window.
  useEffect(() => {
    savedRef.current = stored;
    setDraft(stored);
  }, [stored]);

  /** Saves a changed draft, trimmed; an empty one removes the instructions. */
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === savedRef.current) {
      setDraft(trimmed);
      return;
    }
    savedRef.current = trimmed;
    const next = { ...settings };
    if (trimmed) next.instructions = trimmed;
    else delete next.instructions;
    onSave(next);
  };

  // Closing the settings with Escape takes the field away while it has focus,
  // and no blur comes: what was typed is saved as the field goes.
  const commitRef = useRef(commit);
  useLayoutEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => () => commitRef.current(), []);

  return (
    <div className="ws-card-instructions">
      <span className="ws-card-label">Title instructions</span>
      <p className="ws-panel-hint">
        Appended to the prompt for new and regenerated session titles.
      </p>
      <textarea
        className="dialog-input ws-textarea ws-textarea--prose"
        rows={3}
        aria-label="Title instructions"
        placeholder="Keep titles to a few words. Lead with the main subject."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </div>
  );
}
