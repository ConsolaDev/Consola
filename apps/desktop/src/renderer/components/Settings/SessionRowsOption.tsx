import { useId } from 'react';
import { SIDEBAR_DENSITIES, useSettingsStore } from '../../stores/settingsStore';
import { DENSITY_COPY, DensitySample } from '../Sidebar/DensityPreview';
import './styles.css';

/**
 * Settings → Sessions → Session rows: the sidebar's density, chosen by
 * looking at the same four sessions drawn both ways. The navigation menu
 * beside the search field offers the same choice, one click from the list.
 *
 * Native radios under the cards, so Tab reaches the chosen one and the arrow
 * keys move the choice, as in any radio group.
 */
export function SessionRowsOption() {
  const density = useSettingsStore((state) => state.sidebarDensity);
  const setDensity = useSettingsStore((state) => state.setSidebarDensity);
  const id = useId();

  return (
    <div className="settings-modal-option">
      <div className="settings-modal-option-info">
        <span id={`${id}-label`} className="settings-modal-option-label">
          Session rows
        </span>
        <span id={`${id}-description`} className="settings-modal-option-description">
          How much each session says in the sidebar. Compact fits about twice as many on screen;
          what it leaves out stays in each row’s tooltip.
        </span>
      </div>
      <div
        className="session-rows-picker"
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
      >
        {SIDEBAR_DENSITIES.map((option) => {
          const checked = density === option;
          return (
            <label
              key={option}
              className="session-rows-card"
              data-state={checked ? 'checked' : 'unchecked'}
            >
              <input
                type="radio"
                name={`${id}-density`}
                value={option}
                checked={checked}
                onChange={() => setDensity(option)}
                className="session-rows-card-input"
                aria-label={DENSITY_COPY[option].label}
                aria-describedby={`${id}-${option}`}
              />
              <span className="session-rows-card-preview">
                <DensitySample density={option} />
              </span>
              <span className="session-rows-card-caption">
                <span className="session-rows-card-radio" aria-hidden="true" />
                <span className="session-rows-card-text">
                  <span className="session-rows-card-label">{DENSITY_COPY[option].label}</span>
                  <span id={`${id}-${option}`} className="session-rows-card-hint">
                    {DENSITY_COPY[option].hint}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
