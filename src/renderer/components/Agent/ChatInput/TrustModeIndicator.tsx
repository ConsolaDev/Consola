import { useCallback } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import type { TrustMode } from '../../../../shared/types';
import './trust-mode-indicator.css';

interface TrustModeIndicatorProps {
  trustMode: TrustMode;
  onSetTrustMode: (mode: TrustMode) => void;
  pendingInputsCount: number;
}

export function TrustModeIndicator({
  trustMode,
  onSetTrustMode,
  pendingInputsCount
}: TrustModeIndicatorProps) {
  const handleToggle = useCallback(() => {
    onSetTrustMode(trustMode === 'session' ? 'off' : 'session');
  }, [trustMode, onSetTrustMode]);

  // Active state — trust mode on
  if (trustMode === 'session') {
    return (
      <button
        className="trust-mode-indicator active"
        onClick={handleToggle}
        title="Trust mode active — click to disable"
      >
        <span className="trust-mode-indicator-glow" />
        <span className="trust-mode-indicator-badge active">
          <ShieldCheck size={11} strokeWidth={2} />
        </span>
        <span className="trust-mode-indicator-label active">TRUST</span>
      </button>
    );
  }

  // Off state — always visible so user can enable trust mode
  // Highlight with pending count when there are queued approvals
  return (
    <button
      className={`trust-mode-indicator ${pendingInputsCount > 0 ? 'prompt' : 'idle'}`}
      onClick={handleToggle}
      title="Enable trust mode to auto-approve all actions"
    >
      <span className="trust-mode-indicator-badge">
        <ShieldOff size={11} strokeWidth={2} />
        {pendingInputsCount > 0 && (
          <span className="trust-mode-indicator-count">{pendingInputsCount}</span>
        )}
      </span>
      {pendingInputsCount > 0 && (
        <span className="trust-mode-indicator-label">pending</span>
      )}
    </button>
  );
}
