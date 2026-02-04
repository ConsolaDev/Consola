export interface ParsedToolInput {
  displayName: string;     // e.g., "Bash", "Edit"
  primaryArg: string;      // e.g., "npm run build", "src/index.ts"
  secondaryInfo?: string;  // e.g., line range for Read
  rawInput: unknown;       // Full input for detailed view
}

interface BashInput {
  command: string;
  description?: string;
}

interface ReadInput {
  file_path: string;
  limit?: number;
  offset?: number;
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface WriteInput {
  file_path: string;
  content: string;
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
}

interface GlobInput {
  pattern: string;
  path?: string;
}

interface TaskInput {
  prompt: string;
  subagent_type: string;
  description?: string;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function getFirstLine(str: string): string {
  const firstLine = str.split('\n')[0];
  return truncate(firstLine, 60);
}

export function parseToolInput(toolName: string, input: unknown): ParsedToolInput {
  const parsed: ParsedToolInput = {
    displayName: toolName,
    primaryArg: '',
    rawInput: input
  };

  if (!input || typeof input !== 'object') {
    return parsed;
  }

  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      const bashInput = inp as BashInput;
      parsed.primaryArg = getFirstLine(bashInput.command || '');
      break;
    }

    case 'Read': {
      const readInput = inp as ReadInput;
      parsed.primaryArg = readInput.file_path || '';
      if (readInput.limit || readInput.offset) {
        const parts: string[] = [];
        if (readInput.offset) parts.push(`offset ${readInput.offset}`);
        if (readInput.limit) parts.push(`limit ${readInput.limit}`);
        parsed.secondaryInfo = parts.join(', ');
      }
      break;
    }

    case 'Edit': {
      const editInput = inp as EditInput;
      parsed.primaryArg = editInput.file_path || '';
      break;
    }

    case 'Write': {
      const writeInput = inp as WriteInput;
      parsed.primaryArg = writeInput.file_path || '';
      break;
    }

    case 'Grep': {
      const grepInput = inp as GrepInput;
      parsed.primaryArg = truncate(grepInput.pattern || '', 40);
      if (grepInput.path) {
        parsed.secondaryInfo = `in ${grepInput.path}`;
      } else if (grepInput.glob) {
        parsed.secondaryInfo = `glob ${grepInput.glob}`;
      }
      break;
    }

    case 'Glob': {
      const globInput = inp as GlobInput;
      parsed.primaryArg = globInput.pattern || '';
      if (globInput.path) {
        parsed.secondaryInfo = `in ${globInput.path}`;
      }
      break;
    }

    case 'Task': {
      const taskInput = inp as TaskInput;
      parsed.primaryArg = taskInput.subagent_type || 'agent';
      if (taskInput.description) {
        parsed.secondaryInfo = truncate(taskInput.description, 40);
      }
      break;
    }

    case 'WebFetch': {
      const url = (inp as { url?: string }).url;
      if (url) {
        parsed.primaryArg = truncate(url, 50);
      }
      break;
    }

    case 'WebSearch': {
      const query = (inp as { query?: string }).query;
      if (query) {
        parsed.primaryArg = truncate(query, 50);
      }
      break;
    }

    default: {
      // For unknown tools, try to extract a sensible primary arg
      const keys = Object.keys(inp);
      if (keys.length > 0) {
        const firstValue = inp[keys[0]];
        if (typeof firstValue === 'string') {
          parsed.primaryArg = truncate(firstValue, 50);
        }
      }
      break;
    }
  }

  return parsed;
}
