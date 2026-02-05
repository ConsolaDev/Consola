import { useState, useMemo } from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { codeTheme } from '../../utils/codeTheme';
import { usePreviewTabStore } from '../../stores/previewTabStore';

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

// Get file icon based on extension
function getFileIcon(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const iconMap: Record<string, string> = {
    ts: '◇',
    tsx: '◇',
    js: '◆',
    jsx: '◆',
    css: '●',
    scss: '●',
    html: '▣',
    json: '{ }',
    md: '¶',
    py: '◈',
    go: '◎',
    rs: '⬡',
  };
  return iconMap[ext] || '◦';
}

export function FileContentBlock({ file, maxLines = 4 }: FileContentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const openFile = usePreviewTabStore((s) => s.openFile);

  const lines = useMemo(() => file.content.split('\n'), [file.content]);
  const language = useMemo(() => getLanguageFromPath(file.filePath), [file.filePath]);
  const fileIcon = useMemo(() => getFileIcon(file.filePath), [file.filePath]);

  const shouldCollapse = lines.length > maxLines;

  const displayedLines = useMemo(() => {
    if (!shouldCollapse || expanded) {
      return lines;
    }
    return lines.slice(0, maxLines);
  }, [lines, shouldCollapse, expanded, maxLines]);

  const hiddenLineCount = lines.length - maxLines;

  const handleOpenInPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    openFile(file.filePath);
  };

  return (
    <Box className={`file-content-block ${expanded ? 'expanded' : 'collapsed'}`}>
      <Flex className="file-content-header" align="center" justify="between">
        <Flex align="center" gap="2" className="file-content-meta">
          <span className="file-icon">{fileIcon}</span>
          <Text size="1" className="file-content-path" title={file.filePath}>
            {getFileName(file.filePath)}
          </Text>
          <Text size="1" className="file-content-info">
            {file.numLines} {file.numLines === 1 ? 'line' : 'lines'}
            {file.startLine > 1 && ` · from L${file.startLine}`}
          </Text>
        </Flex>
        <Flex align="center" gap="1" className="file-content-actions">
          <button
            className="file-action-btn"
            onClick={handleOpenInPanel}
            title="Open in preview panel"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/>
              <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/>
            </svg>
          </button>
        </Flex>
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
            fontSize: '11px',
            lineHeight: '1.4',
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
          className="file-expand-bar"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <span className="expand-text">↑ Collapse</span>
          ) : (
            <span className="expand-text">+{hiddenLineCount} more lines</span>
          )}
        </Box>
      )}
    </Box>
  );
}
