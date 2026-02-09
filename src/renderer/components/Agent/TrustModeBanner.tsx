import { useCallback, useState, useEffect } from 'react';
import { ShieldCheck, X, Zap } from 'lucide-react';
import type { TrustMode } from '../../../shared/types';

interface TrustModeBannerProps {
  trustMode: TrustMode;
  trustModeEnabledAt?: number;
  onSetTrustMode: (mode: TrustMode) => void;
  pendingInputsCount: number;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function TrustModeBanner({
  trustMode,
  trustModeEnabledAt,
  onSetTrustMode,
  pendingInputsCount
}: TrustModeBannerProps) {
  const [duration, setDuration] = useState<string>('');

  // Update duration counter when trust mode is active
  useEffect(() => {
    if (trustMode !== 'session' || !trustModeEnabledAt) {
      setDuration('');
      return;
    }

    const updateDuration = () => {
      setDuration(formatDuration(Date.now() - trustModeEnabledAt));
    };

    updateDuration();
    const interval = setInterval(updateDuration, 1000);
    return () => clearInterval(interval);
  }, [trustMode, trustModeEnabledAt]);

  const handleEnableTrustMode = useCallback(() => {
    onSetTrustMode('session');
  }, [onSetTrustMode]);

  const handleDisableTrustMode = useCallback(() => {
    onSetTrustMode('off');
  }, [onSetTrustMode]);

  // Show compact activation prompt when there are pending inputs and trust mode is off
  if (trustMode === 'off' && pendingInputsCount > 0) {
    return (
      <div className="trust-mode-topbar prompt">
        <div className="trust-mode-topbar-inner">
          <div className="trust-mode-topbar-dot prompt" />
          <span className="trust-mode-topbar-label">
            {pendingInputsCount} pending {pendingInputsCount === 1 ? 'approval' : 'approvals'}
          </span>
          <span className="trust-mode-topbar-separator">·</span>
          <button
            className="trust-mode-topbar-action"
            onClick={handleEnableTrustMode}
          >
            <Zap size={11} />
            Auto-approve
          </button>
        </div>
      </div>
    );
  }

  // Show compact active trust mode strip
  if (trustMode === 'session') {
    return (
      <div className="trust-mode-topbar active">
        <div className="trust-mode-topbar-shimmer" />
        <div className="trust-mode-topbar-inner">
          <div className="trust-mode-topbar-dot active">
            <ShieldCheck size={10} />
          </div>
          <span className="trust-mode-topbar-label active">Trust Mode</span>
          <span className="trust-mode-topbar-separator">·</span>
          <span className="trust-mode-topbar-duration">{duration}</span>
          <button
            className="trust-mode-topbar-dismiss"
            onClick={handleDisableTrustMode}
            title="Disable trust mode"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    );
  }

  // No banner when trust mode is off and no pending inputs
  return null;
}
