import { useCallback, useState, useEffect } from 'react';
import { Flex, Text } from '@radix-ui/themes';
import { Shield, ShieldCheck, X, Zap } from 'lucide-react';
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
  const [isExpanding, setIsExpanding] = useState(false);

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
    setIsExpanding(false);
    onSetTrustMode('session');
  }, [onSetTrustMode]);

  const handleDisableTrustMode = useCallback(() => {
    onSetTrustMode('off');
  }, [onSetTrustMode]);

  // Show activation prompt when there are pending inputs and trust mode is off
  if (trustMode === 'off' && pendingInputsCount > 0) {
    return (
      <div className="trust-mode-prompt">
        <div className="trust-mode-prompt-glow" />
        <Flex align="center" gap="3" className="trust-mode-prompt-content">
          <div className="trust-mode-icon-container prompt">
            <Shield size={16} />
          </div>
          <Flex direction="column" gap="0" className="trust-mode-prompt-text">
            <Text size="2" weight="medium" className="trust-mode-prompt-title">
              Auto-approve for session?
            </Text>
            <Text size="1" className="trust-mode-prompt-subtitle">
              Skip approval dialogs for all actions
            </Text>
          </Flex>
          <button
            className="trust-mode-enable-btn"
            onClick={handleEnableTrustMode}
          >
            <Zap size={14} />
            Enable
          </button>
        </Flex>
      </div>
    );
  }

  // Show active trust mode banner
  if (trustMode === 'session') {
    return (
      <div className="trust-mode-banner active">
        <div className="trust-mode-banner-shimmer" />
        <Flex align="center" justify="between" className="trust-mode-banner-content">
          <Flex align="center" gap="3">
            <div className="trust-mode-icon-container active">
              <ShieldCheck size={16} />
            </div>
            <Flex direction="column" gap="0">
              <Text size="2" weight="medium" className="trust-mode-active-title">
                Trust Mode Active
              </Text>
              <Text size="1" className="trust-mode-active-duration">
                Auto-approving all actions · {duration}
              </Text>
            </Flex>
          </Flex>
          <button
            className="trust-mode-disable-btn"
            onClick={handleDisableTrustMode}
            title="Disable trust mode"
          >
            <X size={14} />
          </button>
        </Flex>
      </div>
    );
  }

  // No banner when trust mode is off and no pending inputs
  return null;
}
