import { memo } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { parseToolInput } from './toolInputParser';
import { parseBashOutput } from './toolOutputParser';
import { ToolOutput } from './ToolOutput';
import { DiffView } from './DiffView';
import { BashOutput } from './BashOutput';
import { FileContentBlock, type FileContent } from './FileContentBlock';

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

// Tool output with file content (from Read tool)
interface FileToolOutput {
  type: 'text';
  file: FileContent;
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

function isFileToolOutput(output: unknown): output is FileToolOutput {
  if (!output || typeof output !== 'object') return false;
  const obj = output as Record<string, unknown>;
  if (obj.type !== 'text' || !obj.file || typeof obj.file !== 'object') return false;
  const file = obj.file as Record<string, unknown>;
  return (
    typeof file.filePath === 'string' &&
    file.filePath.length > 0 &&  // Must have a non-empty file path
    typeof file.content === 'string'
  );
}

export const ToolBlock = memo(function ToolBlock({ name, input, status, output }: ToolBlockProps) {
  const parsed = parseToolInput(name, input);

  // Check if this is an Edit tool with valid input
  const isEdit = name === 'Edit' && isEditInput(input);
  const editInput = isEdit ? (input as EditInput) : null;

  // Check if this is a Bash tool with structured output
  const bashOutput = name === 'Bash' ? parseBashOutput(output) : null;

  // Check if output contains file content (from Read tool)
  const fileOutput = isFileToolOutput(output) ? output : null;

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
      {showOutput && bashOutput && (
        <BashOutput
          stdout={bashOutput.stdout}
          stderr={bashOutput.stderr}
          interrupted={bashOutput.interrupted}
        />
      )}
      {showOutput && fileOutput && (
        <FileContentBlock file={fileOutput.file} />
      )}
      {showOutput && !isEdit && !bashOutput && !fileOutput && output !== undefined && (
        <ToolOutput content={output} />
      )}
    </Box>
  );
});
