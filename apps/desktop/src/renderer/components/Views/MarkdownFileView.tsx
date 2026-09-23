import { useEffect, useMemo, useState } from 'react';
import {Box, Flex, ScrollArea, Text} from '@radix-ui/themes';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { MarkdownRenderer } from '../Markdown';
import { fileBridge } from '../../services/fileBridge';
import { AlertCircle, Loader2, Eye, Code2 } from 'lucide-react';
import { codeTheme, codeCustomStyle } from '../../utils/codeTheme';
import { useSelectAll } from '../../hooks/useSelectAll';
import './styles.css';

interface MarkdownFileViewProps {
  filePath: string;
}

type ViewMode = 'preview' | 'source';

export function MarkdownFileView({ filePath }: MarkdownFileViewProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('preview');
  const contentRef = useSelectAll<HTMLDivElement>();

  useEffect(() => {
    async function loadFile() {
      setLoading(true);
      setError(null);
      try {
        const fileContent = await fileBridge.readFile(filePath);
        setContent(fileContent);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to load file: ${err}`);
      } finally {
        setLoading(false);
      }
    }
    loadFile();
  }, [filePath]);

  // Memoize both views so switching modes doesn't re-parse content.
  // Must be above early returns to satisfy React's rules of hooks.
  const previewView = useMemo(() => <MarkdownRenderer content={content} />, [content]);
  const sourceView = useMemo(() => (
    <SyntaxHighlighter
      style={codeTheme}
      language="markdown"
      showLineNumbers
      customStyle={{
        ...codeCustomStyle,
        background: 'transparent',
        padding: 'var(--space-4)',
        margin: 0,
      }}
      lineNumberStyle={{
        minWidth: '3em',
        paddingRight: '1em',
        color: 'var(--color-text-disabled)',
        userSelect: 'none',
      }}
    >
      {content}
    </SyntaxHighlighter>
  ), [content]);

  if (loading) {
    return (
      <Flex align="center" justify="center" className="markdown-file-view loading">
        <Loader2 className="spinner" size={24} />
        <Text color="gray" ml="2">Loading...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="2" className="markdown-file-view error">
        <AlertCircle size={32} color="var(--red-9)" />
        <Text color="red">{error}</Text>
      </Flex>
    );
  }

  return (
    <Box className="markdown-file-view">
      {/* View mode toggle */}
      <div className="markdown-view-toggle-bar">
        <div className="markdown-view-toggle">
          <button
            className={`markdown-view-toggle-btn ${viewMode === 'preview' ? 'active' : ''}`}
            onClick={() => setViewMode('preview')}
            aria-pressed={viewMode === 'preview'}
          >
            <Eye size={14} />
            <span>Preview</span>
          </button>
          <button
            className={`markdown-view-toggle-btn ${viewMode === 'source' ? 'active' : ''}`}
            onClick={() => setViewMode('source')}
            aria-pressed={viewMode === 'source'}
          >
            <Code2 size={14} />
            <span>Source</span>
          </button>
          <div
            className="markdown-view-toggle-indicator"
            data-active={viewMode}
          />
        </div>
      </div>

      {/* Content area - both views stay mounted, toggled via display */}
      <ScrollArea className="markdown-view-content-wrapper">
        <div ref={contentRef} tabIndex={0} className="markdown-view-content-selectable">
          <Box p="4" pr="6" className="markdown-view-panel markdown-preview-view" style={{ display: viewMode === 'preview' ? undefined : 'none' }}>
            {previewView}
          </Box>
          <div className="markdown-view-panel markdown-source-view" style={{ display: viewMode === 'source' ? undefined : 'none' }}>
            {sourceView}
          </div>
        </div>
      </ScrollArea>
    </Box>
  );
}
