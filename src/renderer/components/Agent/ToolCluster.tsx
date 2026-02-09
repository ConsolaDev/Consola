import { useState, useMemo, useEffect, memo } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { ToolBlock, type ToolStatus } from './ToolBlock';
import { getClusterSummary } from './groupContentBlocks';
import type { ToolUseBlock, ToolExecution } from '../../stores/agentStore';

interface ToolClusterProps {
  blocks: ToolUseBlock[];
  toolHistory: ToolExecution[];
}

type ClusterStatus = 'pending' | 'in-progress' | 'complete' | 'error';

interface ToolStatusInfo {
  status: ToolStatus;
  toolResult: ToolExecution | undefined;
}

export const ToolCluster = memo(function ToolCluster({ blocks, toolHistory }: ToolClusterProps) {
  const [expanded, setExpanded] = useState(false);

  // Compute per-tool statuses from toolHistory
  const toolStatuses = useMemo((): ToolStatusInfo[] => {
    return blocks.map(block => {
      const toolResult = toolHistory.find(t => t.toolUseId === block.id);
      let status: ToolStatus = 'pending';
      if (toolResult) {
        status = toolResult.status === 'error' ? 'error' : 'complete';
      }
      return { status, toolResult };
    });
  }, [blocks, toolHistory]);

  // Derive overall cluster status
  const clusterStatus = useMemo((): ClusterStatus => {
    const hasError = toolStatuses.some(t => t.status === 'error');
    if (hasError) return 'error';

    const allComplete = toolStatuses.every(t => t.status === 'complete');
    if (allComplete) return 'complete';

    const anyComplete = toolStatuses.some(t => t.status === 'complete');
    if (anyComplete) return 'in-progress';

    return 'pending';
  }, [toolStatuses]);

  // Auto-expand on error
  useEffect(() => {
    if (clusterStatus === 'error') {
      setExpanded(true);
    }
  }, [clusterStatus]);

  // Cluster summary (type counts)
  const summary = useMemo(() => getClusterSummary(blocks), [blocks]);

  // Count completed tools
  const completedCount = toolStatuses.filter(t => t.status === 'complete').length;

  // Build header text
  const headerParts = useMemo(() => {
    const parts: { text: string; className: string }[] = [];

    // Per-type breakdown with status indicators
    for (const [toolName, count] of summary.typeCounts) {
      // Find statuses for this tool type
      const typeStatuses = blocks
        .map((b, i) => ({ block: b, status: toolStatuses[i] }))
        .filter(({ block }) => block.name === toolName);

      const typeComplete = typeStatuses.filter(t => t.status.status === 'complete').length;
      const typeError = typeStatuses.some(t => t.status.status === 'error');
      const typePending = typeStatuses.some(t => t.status.status === 'pending');

      let indicator = '';
      let className = 'tool-cluster-type';
      if (typeError) {
        indicator = ' ✗';
        className += ' error';
      } else if (typeComplete === count) {
        indicator = ' ✓';
        className += ' complete';
      } else if (typePending && typeComplete > 0) {
        indicator = ' ⏳';
        className += ' pending';
      } else if (typePending) {
        className += ' pending';
      }

      const label = count > 1 ? `${toolName}(${count})${indicator}` : `${toolName}${indicator}`;
      parts.push({ text: label, className });
    }

    return parts;
  }, [blocks, summary, toolStatuses]);

  // Count text: "N actions" or "M of N actions"
  const countText = clusterStatus === 'in-progress'
    ? `${completedCount} of ${summary.total} actions`
    : `${summary.total} actions`;

  return (
    <Box className={`tool-cluster ${clusterStatus}`}>
      <Flex
        align="center"
        gap="2"
        className="tool-cluster-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-cluster-chevron">{expanded ? '▼' : '▶'}</span>
        <Text className="tool-cluster-count" size="2">
          {countText}
        </Text>
        <Text className="tool-cluster-separator" size="1">·</Text>
        <Flex gap="2" className="tool-cluster-summary" wrap="wrap">
          {headerParts.map((part, i) => (
            <Text key={i} className={part.className} size="1">
              {part.text}
            </Text>
          ))}
        </Flex>
      </Flex>

      {expanded && (
        <Box className="tool-cluster-items">
          {blocks.map((block, i) => (
            <ToolBlock
              key={block.id}
              name={block.name}
              input={block.input}
              status={toolStatuses[i].status}
              output={toolStatuses[i].toolResult?.toolResponse}
            />
          ))}
        </Box>
      )}
    </Box>
  );
});
