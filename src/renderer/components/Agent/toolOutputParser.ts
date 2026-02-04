export interface ParsedToolOutput {
  content: string;
  language?: string;  // 'json', 'bash', etc.
  isError: boolean;
}

// Bash output format from the agent
export interface BashOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
}

function isBashOutput(response: unknown): response is BashOutput {
  if (!response || typeof response !== 'object') return false;
  const obj = response as Record<string, unknown>;
  return (
    typeof obj.stdout === 'string' &&
    typeof obj.stderr === 'string' &&
    typeof obj.interrupted === 'boolean'
  );
}

export function parseBashOutput(response: unknown): BashOutput | null {
  return isBashOutput(response) ? response : null;
}

export function parseToolOutput(response: unknown): ParsedToolOutput {
  // Handle null/undefined
  if (response === null || response === undefined) {
    return { content: '', isError: false };
  }

  // Handle error objects
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;

    // Check for error indicator
    if (obj.error || obj.isError || obj.is_error) {
      const errorMessage = obj.error || obj.message || obj.error_message || 'Unknown error';
      return {
        content: String(errorMessage),
        isError: true
      };
    }

    // Check for content/result fields (common patterns)
    if (typeof obj.content === 'string') {
      return { content: obj.content, isError: false };
    }
    if (typeof obj.result === 'string') {
      return { content: obj.result, isError: false };
    }
    if (typeof obj.output === 'string') {
      return { content: obj.output, isError: false };
    }

    // Stringify objects with formatting
    try {
      return {
        content: JSON.stringify(response, null, 2),
        language: 'json',
        isError: false
      };
    } catch {
      return { content: String(response), isError: false };
    }
  }

  // Handle arrays
  if (Array.isArray(response)) {
    // If array of strings, join with newlines
    if (response.every(item => typeof item === 'string')) {
      return { content: response.join('\n'), isError: false };
    }
    // Otherwise stringify
    try {
      return {
        content: JSON.stringify(response, null, 2),
        language: 'json',
        isError: false
      };
    } catch {
      return { content: String(response), isError: false };
    }
  }

  // Handle primitives
  return { content: String(response), isError: false };
}

export function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}
