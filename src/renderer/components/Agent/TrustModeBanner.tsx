import { useCallback } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { TrustMode } from '../../../shared/types';
import './trust-mode-banner.css';

interface TrustModeBannerProps {
  trustMode: TrustMode;
  onSetTrustMode: (mode: TrustMode) => void;
  pendingCount: number;
}

export function TrustModeBanner({ trustMode, onSetTrustMode, pendingCount }: TrustModeBannerProps) {
  const handleEnable = useCallback(() => {
    onSetTrustMode('session');
  }, [onSetTrustMode]);

  // Only show when trust mode is off and there are pending approvals
  if (trustMode === 'session' || pendingCount === 0) return null;

  return (
    <div className="trust-mode-banner">
      <div className="trust-mode-banner-content">
        <div className="trust-mode-banner-icon">
          <ShieldCheck size={14} strokeWidth={2} />
        </div>
        <span className="trust-mode-banner-text">
          <strong>{pendingCount}</strong> {pendingCount === 1 ? 'action needs' : 'actions need'} approval
        </span>
      </div>
      <button className="trust-mode-banner-btn" onClick={handleEnable}>
        Trust for session
      </button>
    </div>
  );
}
