import { FolderOpen } from 'lucide-react';
import type { HarnessDriverId } from '../../../shared/types';
import { getDriverDescriptor } from '../../../shared/constants';
import { dialogBridge } from '../../services/dialogBridge';
import { HARNESS_ACCENT_COLORS } from '../../stores/harnessStore';
import './styles.css';

/**
 * The editable shape of a harness.
 *
 * Launch arguments are held as the raw string the user typed and only split
 * into argv on save, so editing never mangles what they wrote.
 */
export interface HarnessDraft {
  id: string;
  driverId: HarnessDriverId;
  name: string;
  accentColor: string;
  binaryPath: string;
  configDir: string;
  launchArgs: string;
}

type DraftChange = (updates: Partial<HarnessDraft>) => void;

/**
 * Name, routing key and colour.
 *
 * Shared by the add wizard and the edit dialog so the two can never drift
 * apart on validation or wording.
 */
export function IdentityFields({
  draft,
  onChange,
  idEditable,
  idError,
}: {
  draft: HarnessDraft;
  onChange: DraftChange;
  idEditable: boolean;
  idError?: string;
}) {
  return (
    <div className="dialog-form">
      <div className="dialog-field">
        <label className="dialog-label" htmlFor="harness-name">
          Name
        </label>
        <input
          id="harness-name"
          className="dialog-input"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="e.g. Work"
          autoFocus
        />
        <span className="harness-field-hint">Shown in the harness list and pickers.</span>
      </div>

      <div className="dialog-field">
        <label className="dialog-label" htmlFor="harness-id">
          Instance ID
        </label>
        <input
          id="harness-id"
          className="dialog-input"
          value={draft.id}
          onChange={(event) => onChange({ id: event.target.value })}
          placeholder="claude-work"
          disabled={!idEditable}
        />
        <span className={`harness-field-hint ${idError ? 'harness-field-error' : ''}`}>
          {idError ??
            (idEditable
              ? "Routing key used by sessions. Letters, digits, '-', or '_'."
              : 'Fixed once created, because existing sessions route through it.')}
        </span>
      </div>

      <div className="dialog-field">
        <span className="dialog-label">Accent color</span>
        <div className="harness-color-picker">
          {HARNESS_ACCENT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`harness-color-swatch ${
                draft.accentColor === color ? 'selected' : ''
              }`}
              style={{ background: color }}
              onClick={() => onChange({ accentColor: color })}
              aria-label={`Accent color ${color}`}
              aria-pressed={draft.accentColor === color}
            />
          ))}
        </div>
        <span className="harness-field-hint">Marker shown beside this harness.</span>
      </div>
    </div>
  );
}

/**
 * Binary, profile directory and launch arguments.
 *
 * Every field is optional: left blank, the harness resolves exactly the way
 * Consola does with no harness configured at all.
 */
export function ConfigFields({
  draft,
  onChange,
}: {
  draft: HarnessDraft;
  onChange: DraftChange;
}) {
  const driver = getDriverDescriptor(draft.driverId);

  const browseForConfigDir = async () => {
    const selection = await dialogBridge.selectFolder();
    if (selection) onChange({ configDir: selection.path });
  };

  return (
    <div className="dialog-form">
      <div className="dialog-field">
        <label className="dialog-label" htmlFor="harness-binary">
          Binary path
        </label>
        <input
          id="harness-binary"
          className="dialog-input"
          value={draft.binaryPath}
          onChange={(event) => onChange({ binaryPath: event.target.value })}
          placeholder={driver.binaryName}
        />
        <span className="harness-field-hint">
          Leave blank to find <code>{driver.binaryName}</code> on your PATH.
        </span>
      </div>

      <div className="dialog-field">
        <label className="dialog-label" htmlFor="harness-config-dir">
          {driver.configDirEnvVar} path
        </label>
        <div className="harness-input-row">
          <input
            id="harness-config-dir"
            className="dialog-input"
            value={draft.configDir}
            onChange={(event) => onChange({ configDir: event.target.value })}
            placeholder={driver.defaultConfigDir}
          />
          <button
            type="button"
            className="dialog-button-secondary harness-browse-button"
            onClick={browseForConfigDir}
          >
            <FolderOpen size={14} />
            Browse
          </button>
        </div>
        <span className="harness-field-hint">
          A separate config directory keeps this harness's login and history to
          itself. Leave blank to share the default one.
        </span>
      </div>

      <div className="dialog-field">
        <label className="dialog-label" htmlFor="harness-args">
          Launch arguments
        </label>
        <input
          id="harness-args"
          className="dialog-input"
          value={draft.launchArgs}
          onChange={(event) => onChange({ launchArgs: event.target.value })}
          placeholder="e.g. --permission-mode plan"
        />
        <span className="harness-field-hint">
          Passed to every session this harness starts.
        </span>
      </div>
    </div>
  );
}
