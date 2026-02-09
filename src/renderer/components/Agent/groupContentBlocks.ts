import type { ContentBlock, ToolUseBlock, Message, AssistantMessage } from '../../stores/agentStore';

// ============================================
// Message-level grouping (for AgentPanel)
// ============================================

export type GroupedMessage =
  | { kind: 'single'; message: Message }
  | { kind: 'tool-cluster'; messages: AssistantMessage[]; toolBlocks: ToolUseBlock[] };

/**
 * Check if a message contains only tool_use blocks (no text, no thinking)
 */
function isToolOnlyMessage(msg: Message): msg is AssistantMessage {
  if (msg.type !== 'assistant') return false;
  const blocks = msg.contentBlocks;
  if (!blocks || blocks.length === 0) return false;
  return blocks.every(b => b.type === 'tool_use');
}

/**
 * Groups consecutive assistant messages that only contain tool_use blocks.
 * This handles the SDK behavior where each tool call comes as a separate message.
 */
export function groupMessages(messages: Message[]): GroupedMessage[] {
  const result: GroupedMessage[] = [];
  let toolRun: AssistantMessage[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 0) return;

    if (toolRun.length >= 2) {
      // Cluster: 2+ consecutive tool-only messages
      const toolBlocks = toolRun.flatMap(m =>
        (m.contentBlocks || []).filter((b): b is ToolUseBlock => b.type === 'tool_use')
      );
      result.push({ kind: 'tool-cluster', messages: [...toolRun], toolBlocks });
    } else {
      // Single tool-only message — no clustering
      result.push({ kind: 'single', message: toolRun[0] });
    }

    toolRun = [];
  };

  for (const msg of messages) {
    if (isToolOnlyMessage(msg)) {
      toolRun.push(msg);
    } else {
      // Non-tool message: flush any accumulated tool run, then add as single
      flushToolRun();
      result.push({ kind: 'single', message: msg });
    }
  }

  // Flush any trailing tool run
  flushToolRun();

  return result;
}

// ============================================
// Block-level grouping (for ChatMessage - kept for mixed messages)
// ============================================

export type GroupedBlock =
  | { kind: 'single'; block: ContentBlock; index: number }
  | { kind: 'cluster'; blocks: ToolUseBlock[]; indices: number[] };

/**
 * Groups consecutive tool_use content blocks into clusters within a single message.
 * A cluster is 2+ consecutive tool_use blocks not interrupted by text or thinking blocks.
 * Single tool_use blocks (or non-tool blocks) remain as singles.
 */
export function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const result: GroupedBlock[] = [];
  let toolRun: ToolUseBlock[] = [];
  let toolRunIndices: number[] = [];

  const flushToolRun = () => {
    if (toolRun.length === 0) return;

    if (toolRun.length >= 2) {
      // Cluster: 2+ consecutive tool_use blocks
      result.push({ kind: 'cluster', blocks: [...toolRun], indices: [...toolRunIndices] });
    } else {
      // Single tool_use block — no clustering
      result.push({ kind: 'single', block: toolRun[0], index: toolRunIndices[0] });
    }

    toolRun = [];
    toolRunIndices = [];
  };

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    if (block.type === 'tool_use') {
      toolRun.push(block);
      toolRunIndices.push(i);
    } else {
      // Non-tool block: flush any accumulated tool run, then add as single
      flushToolRun();
      result.push({ kind: 'single', block, index: i });
    }
  }

  // Flush any trailing tool run
  flushToolRun();

  return result;
}

export interface ClusterSummary {
  total: number;
  typeCounts: Map<string, number>;
}

/**
 * Compute a summary of tool types in a cluster.
 * Returns the total count and per-type counts (e.g., Read: 4, Grep: 2).
 */
export function getClusterSummary(blocks: ToolUseBlock[]): ClusterSummary {
  const typeCounts = new Map<string, number>();

  for (const block of blocks) {
    const count = typeCounts.get(block.name) || 0;
    typeCounts.set(block.name, count + 1);
  }

  return {
    total: blocks.length,
    typeCounts,
  };
}
