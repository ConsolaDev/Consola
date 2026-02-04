import { Box, Text } from '@radix-ui/themes';
import { ModelUsage } from '../../../shared/types';

interface ContextStatusBarProps {
  model: string | null;
  modelUsage: ModelUsage | null;
}

function formatModelName(modelId: string | null): string {
  if (!modelId) return 'Unknown';

  // Extract friendly name: "claude-sonnet-4-20250514" -> "Sonnet 4"
  // Try pattern: claude-{variant}-{version}-{date}
  const match = modelId.match(/claude-(\w+)-(\d+)/);
  if (match) {
    const [, variant, version] = match;
    return `${variant.charAt(0).toUpperCase() + variant.slice(1)} ${version}`;
  }

  return modelId;
}

export function ContextStatusBar({ model, modelUsage }: ContextStatusBarProps) {
  // Don't render if no data yet
  if (!model && !modelUsage) {
    return null;
  }

  const totalTokens = modelUsage
    ? modelUsage.inputTokens + modelUsage.outputTokens
    : 0;
  const contextWindow = modelUsage?.contextWindow ?? 200_000;
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

  const formatNumber = (n: number) => n.toLocaleString();

  // Determine warning state
  const statusClass = percentage >= 85 ? 'critical' : percentage >= 70 ? 'warning' : '';

  return (
    <Box className={`context-status-bar ${statusClass}`}>
      <Text size="1" className="context-status-text">
        {model && (
          <span className="context-status-model">{formatModelName(model)}</span>
        )}
        {modelUsage && (
          <>
            <span className="context-status-separator">|</span>
            <span className="context-status-tokens">
              {formatNumber(totalTokens)} / {formatNumber(contextWindow)}
            </span>
            <span className="context-status-percentage">
              ({percentage.toFixed(1)}%)
            </span>
          </>
        )}
      </Text>
    </Box>
  );
}
