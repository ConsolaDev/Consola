import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { driverDefaultTitleModel } from '../../../shared/constants';
import type { Harness } from '../../../shared/harness';
import { reconcileTitleSettings } from '../../../shared/sessionTitles';
import type { HarnessModel } from '../../../shared/types';
import type { SessionTitleSettings } from '../../../shared/workspace';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';

interface TitleModelMenuProps {
  settings: SessionTitleSettings;
  /** Selectable harnesses whose driver can write titles. */
  harnesses: Harness[];
  defaultHarness: Harness | undefined;
  /** The harness the title would be written on, for the chip's dot. */
  resolvedHarness: Harness | undefined;
  /** What the chip reads; already worded by the panel. */
  label: string;
  isOff: boolean;
  onChange: (next: SessionTitleSettings) => void;
}

/** Keeps what the person tuned (effort, Fast, instructions); the pin and its model are the pick's. */
function withSource(
  settings: SessionTitleSettings,
  source: SessionTitleSettings['source'],
  pin?: { harnessId: string; model?: string },
): SessionTitleSettings {
  const { effort, fast, instructions } = settings;
  const next: SessionTitleSettings = { source };
  if (pin) {
    next.harnessId = pin.harnessId;
    if (pin.model) next.model = pin.model;
  }
  if (effort !== undefined) next.effort = effort;
  if (fast !== undefined) next.fast = fast;
  if (instructions !== undefined) next.instructions = instructions;
  return next;
}

/** The model chip and its menu: Off, follow the default harness, or one harness's model. */
export function TitleModelMenu({
  settings,
  harnesses,
  defaultHarness,
  resolvedHarness,
  label,
  isOff,
  onChange,
}: TitleModelMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="ws-chip-trigger" aria-label="Text generation model">
          {!isOff && resolvedHarness && (
            <span
              className="workspace-harness-dot"
              style={{ background: resolvedHarness.accentColor }}
              aria-hidden="true"
            />
          )}
          <span className="ws-chip-trigger-label">{label}</span>
          <ChevronDown size={12} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown-content ws-settings-menu"
          sideOffset={6}
          align="end"
        >
          <DropdownMenu.RadioGroup
            value={settings.source === 'pinned' ? '' : settings.source}
            onValueChange={(value) => {
              if (value === 'off' || value === 'default-harness') {
                onChange(withSource(settings, value));
              }
            }}
          >
            <MenuRadio value="off">Off</MenuRadio>
            <MenuRadio value="default-harness">
              {defaultHarness
                ? `Follow default harness (${defaultHarness.name})`
                : 'Follow default harness'}
            </MenuRadio>
          </DropdownMenu.RadioGroup>
          {harnesses.map((harness) => (
            <HarnessModelGroup
              key={harness.id}
              harness={harness}
              settings={settings}
              onChange={onChange}
            />
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuRadio({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <DropdownMenu.RadioItem value={value} className="dropdown-item">
      <span className="ws-menu-indicator" aria-hidden="true">
        <DropdownMenu.ItemIndicator>
          <Check size={12} />
        </DropdownMenu.ItemIndicator>
      </span>
      <span>{children}</span>
    </DropdownMenu.RadioItem>
  );
}

/** Radix radio values must be strings; this one stands for "the harness's own default model". */
const DEFAULT_MODEL = '__default__';

/** One child per harness, so each asks for its own capabilities. */
function HarnessModelGroup({
  harness,
  settings,
  onChange,
}: {
  harness: Harness;
  settings: SessionTitleSettings;
  onChange: (next: SessionTitleSettings) => void;
}) {
  const { capabilities, loading, unavailable, retry } = useHarnessCapabilities(harness, true);
  const driverDefault = driverDefaultTitleModel(harness.driverId);
  const pinnedHere = settings.source === 'pinned' && settings.harnessId === harness.id;
  const current = pinnedHere ? (settings.model ?? DEFAULT_MODEL) : '';
  const models: HarnessModel[] = capabilities?.models ?? [];

  const pick = (value: string) => {
    const model = value === DEFAULT_MODEL ? undefined : value;
    const info = models.find((candidate) => candidate.value === (model ?? driverDefault));
    onChange(
      reconcileTitleSettings(
        withSource(settings, 'pinned', { harnessId: harness.id, model }),
        info,
      ),
    );
  };

  return (
    <>
      <DropdownMenu.Separator className="dropdown-separator" />
      <DropdownMenu.Label className="ws-menu-group-label">{harness.name}</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={current} onValueChange={pick}>
        <MenuRadio value={DEFAULT_MODEL}>{`Default (${driverDefault})`}</MenuRadio>
        {models.map((model) => (
          <MenuRadio key={model.value} value={model.value}>
            {model.displayName}
          </MenuRadio>
        ))}
      </DropdownMenu.RadioGroup>
      {loading && !capabilities && <div className="ws-menu-note">Loading models…</div>}
      {unavailable && (
        <>
          <div className="ws-menu-note">Models unavailable.</div>
          <DropdownMenu.Item
            className="dropdown-item"
            onSelect={(event) => {
              event.preventDefault();
              retry();
            }}
          >
            Retry
          </DropdownMenu.Item>
        </>
      )}
    </>
  );
}
