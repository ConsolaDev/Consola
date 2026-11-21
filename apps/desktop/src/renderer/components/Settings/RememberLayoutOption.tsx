import { useId } from 'react';
import { useSidePanelStore } from '../../stores/sidePanelStore';
import './styles.css';

/**
 * Settings → Appearance → whether the side panel's tabs and split come back
 * at the next launch. Turning it off leaves the arrangement on screen for the
 * rest of the run and stops writing it (`partializeSidePanel`), so the next
 * launch starts from the default: a single hidden group. Sizes and use counts
 * are not covered: they are always remembered.
 *
 * A native checkbox, named by the label and described by the line under it,
 * with the whole row its click target.
 */
export function RememberLayoutOption() {
  const remember = useSidePanelStore((state) => state.rememberLayout);
  const setRemember = useSidePanelStore((state) => state.setRememberLayout);
  const id = useId();

  return (
    <div className="settings-modal-option">
      <label className="remember-layout-option" htmlFor={`${id}-remember`}>
        <input
          id={`${id}-remember`}
          type="checkbox"
          checked={remember}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <span className="settings-modal-option-info">
          <span id={`${id}-label`} className="settings-modal-option-label">
            Remember the side panel’s layout
          </span>
          <span id={`${id}-description`} className="settings-modal-option-description">
            On: tabs and splits come back the way you left them. Off: the side panel starts as a
            single group every time, and a shortcut opens its tab there.
          </span>
        </span>
      </label>
    </div>
  );
}
