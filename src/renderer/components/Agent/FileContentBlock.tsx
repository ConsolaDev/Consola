import { useState, useMemo } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { codeTheme } from '../../utils/codeTheme';

export interface FileContent {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

export interface FileContentBlockProps {
  file: FileContent;
  maxLines?: number;
}

// Map file extensions to Prism language identifiers
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    vue: 'vue',
    svelte: 'svelte',
  };
  return languageMap[ext] || 'text';
}

// Extract just the filename from full path
function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

export function FileContentBlock({ file, maxLines = 30 }: FileContentBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const lines = useMemo(() => file.content.split('\n'), [file.content]);
  const language = useMemo(() => getLanguageFromPath(file.filePath), [file.filePath]);

  const shouldCollapse = lines.length > maxLines;

  const displayedLines = useMemo(() => {
    if (!shouldCollapse || expanded) {
      return lines;
    }
    return lines.slice(0, maxLines);
  }, [lines, shouldCollapse, expanded, maxLines]);

  const hiddenLineCount = lines.length - maxLines;

  return (
    <Box className="file-content-block">
      <Flex className="file-content-header" align="center" gap="2">
        <Text size="1" className="file-content-path" title={file.filePath}>
          {getFileName(file.filePath)}
        </Text>
        <Text size="1" className="file-content-info">
          {file.numLines} {file.numLines === 1 ? 'line' : 'lines'}
          {file.startLine > 1 && ` (from line ${file.startLine})`}
        </Text>
      </Flex>

      <Box className="file-content-code">
        <SyntaxHighlighter
          style={codeTheme}
          language={language}
          PreTag="div"
          showLineNumbers
          startingLineNumber={file.startLine}
          lineNumberContainerProps={{
            className: 'file-content-line-numbers'
          }}
          customStyle={{
            margin: 0,
            padding: 'var(--space-2)',
            background: 'transparent',
            fontSize: 'var(--font-size-xs)',
            lineHeight: 'var(--line-height-normal)',
          }}
          codeTagProps={{
            style: {
              fontFamily: 'var(--font-mono)',
            }
          }}
        >
          {displayedLines.join('\n')}
        </SyntaxHighlighter>

        {shouldCollapse && !expanded && (
          <Box className="file-content-fade" />
        )}
      </Box>

      {shouldCollapse && (
        <Box
          className="tool-expand-button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <Text size="1">Collapse</Text>
          ) : (
            <Text size="1">+{hiddenLineCount} more lines</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
