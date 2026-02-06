import { ModelUsage } from '../../../../shared/types';
import './token-usage.css';

interface TokenUsageIndicatorProps {
  modelUsage: ModelUsage | null;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

export function TokenUsageIndicator({ modelUsage }: TokenUsageIndicatorProps) {
  if (!modelUsage) return null;

  const totalTokens = modelUsage.inputTokens + modelUsage.outputTokens;
  const contextWindow = modelUsage.contextWindow || 200_000;
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

  // Severity thresholds: warning 40-85%, critical >= 85%
  const severity = percentage >= 85 ? 'critical' : percentage >= 40 ? 'warning' : 'normal';

  return (
    <div className="token-usage-indicator" title={buildTooltip(modelUsage)}>
      <span className="token-usage-label">
        {formatTokenCount(totalTokens)}
        <span className="token-usage-separator">/</span>
        {formatTokenCount(contextWindow)}
      </span>
      <span className={`token-usage-pct ${severity}`}>{percentage.toFixed(0)}%</span>
    </div>
  );
}

function buildTooltip(usage: ModelUsage): string {
  return [
    `Input: ${usage.inputTokens.toLocaleString()} tokens`,
    `Output: ${usage.outputTokens.toLocaleString()} tokens`,
    `Cache read: ${usage.cacheReadInputTokens.toLocaleString()}`,
    `Cache creation: ${usage.cacheCreationInputTokens.toLocaleString()}`,
    `Context window: ${usage.contextWindow.toLocaleString()}`,
  ].join('\n');
}
