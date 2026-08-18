import { useState, useEffect, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { Loader2 } from 'lucide-react';
import { gitBridge } from '../../services/gitBridge';
import type { GitDiffResult } from '../../types/electron';
import { getLanguageFromPath } from '../../utils/fileUtils';
import { buildUnifiedDiff } from '../../utils/diffUtils';
import { codeTheme } from '../../utils/codeTheme';
import { useSelectAll } from '../../hooks/useSelectAll';

interface DiffViewProps {
  rootPath: string;
  relativePath: string;
  staged: boolean;
}

/**
 * Renders a single line with syntax highlighting
 */
function HighlightedLine({
  content,
  language
}: {
  content: string;
  language: string;
}) {
  return (
    <SyntaxHighlighter
      style={codeTheme}
      language={language}
      customStyle={{
        margin: 0,
        padding: 0,
        background: 'transparent',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        overflow: 'visible',
      }}
      codeTagProps={{
        style: {
          fontFamily: 'inherit',
        }
      }}
      PreTag="span"
    >
      {content || ' '}
    </SyntaxHighlighter>
  );
}

export function DiffView({ rootPath, relativePath, staged }: DiffViewProps) {
  const [diffData, setDiffData] = useState<GitDiffResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useSelectAll<HTMLDivElement>();

  const language = useMemo(() => getLanguageFromPath(relativePath), [relativePath]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    gitBridge.getDiff(rootPath, relativePath, staged)
      .then((data) => {
        if (data) {
          setDiffData(data);
        } else {
          setError('Failed to load diff');
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [rootPath, relativePath, staged]);

  const unifiedLines = useMemo(() => {
    if (!diffData) return [];
    return buildUnifiedDiff(diffData.oldContent, diffData.newContent, diffData.hunks);
  }, [diffData]);

  if (isLoading) {
    return (
      <div className="diff-view loading">
        <Loader2 size={24} className="spinner" />
        <p>Loading diff...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="diff-view error">
        <p>Error loading diff</p>
        <p className="diff-view-error-detail">{error}</p>
      </div>
    );
  }

  if (!diffData) {
    return (
      <div className="diff-view error">
        <p>No diff data available</p>
      </div>
    );
  }

  if (diffData.isBinary) {
    return (
      <div className="diff-view binary">
        <p>Binary file - diff not available</p>
      </div>
    );
  }

  // For new files, show all lines as added
  if (diffData.isNew && !diffData.isDeleted) {
    const lines = diffData.newContent.split('\n');
    return (
      <div className="diff-view" ref={contentRef} tabIndex={0}>
        <div className="diff-header">
          <span className="diff-header-label diff-header-new">New File</span>
          <span className="diff-header-path">{relativePath}</span>
        </div>
        <div className="diff-unified-content">
          {lines.map((line, idx) => (
            <div key={idx} className="diff-unified-line diff-unified-line-add">
              <span className="diff-unified-gutter diff-unified-gutter-add">+</span>
              <span className="diff-unified-line-number diff-unified-line-number-empty"></span>
              <span className="diff-unified-line-number">{idx + 1}</span>
              <span className="diff-unified-line-content">
                <HighlightedLine content={line} language={language} />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // For deleted files, show all lines as removed
  if (diffData.isDeleted) {
    const lines = diffData.oldContent.split('\n');
    return (
      <div className="diff-view" ref={contentRef} tabIndex={0}>
        <div className="diff-header">
          <span className="diff-header-label diff-header-deleted">Deleted File</span>
          <span className="diff-header-path">{relativePath}</span>
        </div>
        <div className="diff-unified-content">
          {lines.map((line, idx) => (
            <div key={idx} className="diff-unified-line diff-unified-line-remove">
              <span className="diff-unified-gutter diff-unified-gutter-remove">-</span>
              <span className="diff-unified-line-number">{idx + 1}</span>
              <span className="diff-unified-line-number diff-unified-line-number-empty"></span>
              <span className="diff-unified-line-content">
                <HighlightedLine content={line} language={language} />
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Unified diff view
  return (
    <div className="diff-view" ref={contentRef} tabIndex={0}>
      <div className="diff-header">
        <span className="diff-header-label">{staged ? 'Staged' : 'Modified'}</span>
        <span className="diff-header-path">{relativePath}</span>
      </div>
      <div className="diff-unified-content">
        {unifiedLines.map((line, idx) => {
          const lineClass = line.type === 'add'
            ? 'diff-unified-line-add'
            : line.type === 'remove'
              ? 'diff-unified-line-remove'
              : '';

          const gutter = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
          const gutterClass = line.type === 'add'
            ? 'diff-unified-gutter-add'
            : line.type === 'remove'
              ? 'diff-unified-gutter-remove'
              : '';

          return (
            <div key={idx} className={`diff-unified-line ${lineClass}`}>
              <span className={`diff-unified-gutter ${gutterClass}`}>{gutter}</span>
              <span className={`diff-unified-line-number ${line.oldLineNumber === undefined ? 'diff-unified-line-number-empty' : ''}`}>
                {line.oldLineNumber ?? ''}
              </span>
              <span className={`diff-unified-line-number ${line.newLineNumber === undefined ? 'diff-unified-line-number-empty' : ''}`}>
                {line.newLineNumber ?? ''}
              </span>
              <span className="diff-unified-line-content">
                <HighlightedLine content={line.content} language={language} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
