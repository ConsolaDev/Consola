import { Box, Flex, Text } from '@radix-ui/themes';
import { parseToolInput } from './toolInputParser';
import { ToolOutput } from './ToolOutput';
import { DiffView } from './DiffView';

export type ToolStatus = 'pending' | 'complete' | 'error';

export interface ToolBlockProps {
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: unknown;
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function isEditInput(input: unknown): input is EditInput {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  return (
    typeof obj.file_path === 'string' &&
    typeof obj.old_string === 'string' &&
    typeof obj.new_string === 'string'
  );
}

export function ToolBlock({ name, input, status, output }: ToolBlockProps) {
  const parsed = parseToolInput(name, input);

  // Check if this is an Edit tool with valid input
  const isEdit = name === 'Edit' && isEditInput(input);
  const editInput = isEdit ? (input as EditInput) : null;

  // Only show output section when complete/error
  const showOutput = status !== 'pending' && (output !== undefined || isEdit);

  return (
    <Box className="tool-block">
      <Flex align="center" gap="2" className="tool-header">
        <span className={`tool-bullet ${status}`} />
        <Text className="tool-name">{parsed.displayName}</Text>
        {parsed.primaryArg && (
          <Text className="tool-args" title={parsed.primaryArg}>
            {parsed.primaryArg}
          </Text>
        )}
        {parsed.secondaryInfo && (
          <Text className="tool-secondary" title={parsed.secondaryInfo}>
            {parsed.secondaryInfo}
          </Text>
        )}
      </Flex>
      {showOutput && isEdit && editInput && (
        <DiffView
          filePath={editInput.file_path}
          oldString={editInput.old_string}
          newString={editInput.new_string}
        />
      )}
      {showOutput && !isEdit && output !== undefined && (
        <ToolOutput content={output} />
      )}
    </Box>
  );
}
