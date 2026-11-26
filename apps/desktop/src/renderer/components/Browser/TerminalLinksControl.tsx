import { Check } from 'lucide-react';
import type { TerminalLinkRule } from '../../../shared/browser';
import { preferencesBridge } from '../../services/preferencesBridge';
import { usePreferencesStore } from '../../stores/preferencesStore';

const RULES: Array<{ rule: TerminalLinkRule; label: string }> = [
  { rule: 'local', label: 'Local addresses open in Consola' },
  { rule: 'all', label: 'Every link opens in Consola' },
  { rule: 'never', label: 'Every link opens in the system browser' },
];

/**
 * Where a link clicked in a session's terminal opens. Shared by every window:
 * the choice is a preference main keeps, and each terminal reads it at the click.
 */
export function TerminalLinksControl() {
  const current = usePreferencesStore((state) => state.terminalLinks);
  return (
    <div className="ws-choice-list" role="radiogroup" aria-label="Terminal links">
      {RULES.map(({ rule, label }) => (
        <button
          key={rule}
          type="button"
          role="radio"
          aria-checked={current === rule}
          className={`ws-choice-row ${current === rule ? 'selected' : ''}`}
          onClick={() => void preferencesBridge.setTerminalLinks(rule)}
        >
          <span className="ws-choice-name">{label}</span>
          {current === rule && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}
