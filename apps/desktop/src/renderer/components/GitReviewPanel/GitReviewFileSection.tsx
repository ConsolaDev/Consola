import { useState, useEffect, useMemo, useRef, memo, useCallback } from 'react';
import { ChevronRight, Loader2, Code, FileText, Copy, Check } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { gitBridge } from '../../services/gitBridge';
import { fileBridge } from '../../services/fileBridge';
import { FileIcon } from '../FileExplorer/FileIcon';
import { GitFileStatus, GitDiffResult } from '../../types/electron';
import { getLanguageFromPath } from '../../utils/fileUtils';
import { buildUnifiedDiff } from '../../utils/diffUtils';
import { codeTheme } from '../../utils/codeTheme';
import { SelectableCode } from '../CodeSelection';
import { useCodeSelectionContext } from '../../contexts/CodeSelectionContext';

interface GitReviewFileSectionProps {
  rootPath: string;
  filePath: string;
  status: GitFileStatus;
  sectionRef?: (el: HTMLDivElement | null) => void;
}

// Memoized syntax highlighter for an entire code block - renders once per content change
const HighlightedCode = memo(function HighlightedCode({
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
        style: { fontFamily: 'inherit' }
      }}
      PreTag="span"
    >
      {content || ' '}
    </SyntaxHighlighter>
  );
});

// Use granular selectors to prevent unnecessary re-renders
function useIsFileExpanded(filePath: string) {
  return useGitReviewStore(useCallback(
    (state) => state.expandedFiles.has(filePath),
    [filePath]
  ));
}

function useFileViewMode(filePath: string) {
  return useGitReviewStore(useCallback(
    (state) => state.viewMode.get(filePath) ?? 'diff',
    [filePath]
  ));
}

export const GitReviewFileSection = memo(function GitReviewFileSection({
  rootPath,
  filePath,
  status,
  sectionRef
}: GitReviewFileSectionProps) {
  const [diffData, setDiffData] = useState<GitDiffResult | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stats, setStats] = useState({ added: 0, removed: 0 });
  const [copied, setCopied] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Use granular selectors - only re-render when THIS file's state changes
  const isExpanded = useIsFileExpanded(filePath);
  const currentViewMode = useFileViewMode(filePath);
  const toggleFileExpanded = useGitReviewStore((state) => state.toggleFileExpanded);
  const setViewMode = useGitReviewStore((state) => state.setViewMode);
  const refresh = useGitStatusStore((state) => state.refresh);
  const selectionContext = useCodeSelectionContext();

  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);
  const absoluteFilePath = `${rootPath}/${filePath}`;

  const getFilename = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1];
  };

  // Load diff data when expanded
  useEffect(() => {
    if (!isExpanded) return;

    setIsLoading(true);
    const isStaged = status === 'staged';

    gitBridge.getDiff(rootPath, filePath, isStaged)
      .then((data) => {
        if (data) {
          setDiffData(data);
          // Calculate stats
          let added = 0;
          let removed = 0;
          if (data.isNew) {
            added = data.newContent.split('\n').length;
          } else if (data.isDeleted) {
            removed = data.oldContent.split('\n').length;
          } else {
            for (const hunk of data.hunks) {
              for (const line of hunk.lines) {
                if (line.type === 'add') added++;
                if (line.type === 'remove') removed++;
              }
            }
          }
          setStats({ added, removed });
        }
      })
      .finally(() => setIsLoading(false));
  }, [isExpanded, rootPath, filePath, status]);

  // Load file content when switching to file view
  useEffect(() => {
    if (!isExpanded || currentViewMode !== 'file') return;

    const absolutePath = `${rootPath}/${filePath}`;
    fileBridge.readFile(absolutePath)
      .then((content) => setFileContent(content))
      .catch(() => setFileContent(null));
  }, [isExpanded, currentViewMode, rootPath, filePath]);

  // IntersectionObserver for sticky header
  useEffect(() => {
    if (!sentinelRef.current || !headerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        headerRef.current?.classList.toggle('stuck', !entry.isIntersecting);
      },
      { threshold: [1], rootMargin: '-1px 0px 0px 0px' }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, []);

  const setFileExpanded = useGitReviewStore((state) => state.setFileExpanded);

  const handleApproveToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (status === 'staged') {
        await gitBridge.unstageFile(rootPath, filePath);
      } else {
        await gitBridge.stageFile(rootPath, filePath);
        // Collapse the file when approving
        setFileExpanded(filePath, false);
      }
      await refresh(rootPath);
    } catch (error) {
      console.error('Failed to toggle approval:', error);
    }
  };

  const handleViewModeChange = (e: React.MouseEvent, mode: 'diff' | 'file') => {
    e.stopPropagation();
    setViewMode(filePath, mode);
  };

  const handleCopyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const unifiedLines = useMemo(() => {
    if (!diffData) return [];
    return buildUnifiedDiff(diffData.oldContent, diffData.newContent, diffData.hunks);
  }, [diffData]);

  const renderDiffContent = () => {
    if (isLoading) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
          <Loader2 size={16} className="spinner" />
        </div>
      );
    }

    if (!diffData) {
      return (
        <div style={{ padding: 'var(--space-4)', color: 'var(--color-text-tertiary)', fontSize: '12px' }}>
          No diff available
        </div>
      );
    }

    if (diffData.isBinary) {
      return (
        <div style={{ padding: 'var(--space-4)', color: 'var(--color-text-tertiary)', fontSize: '12px' }}>
          Binary file - diff not available
        </div>
      );
    }

    // New file - show all as added
    if (diffData.isNew && !diffData.isDeleted) {
      const lines = diffData.newContent.split('\n');
      return (
        <div className="git-review-inline-diff">
          {lines.map((line, idx) => (
            <div key={idx} className="git-review-inline-diff-line git-review-inline-diff-line-add">
              <span className="git-review-inline-diff-gutter git-review-inline-diff-gutter-add">+</span>
              <span className="git-review-inline-diff-line-number">{idx + 1}</span>
              <span className="git-review-inline-diff-content">
                <HighlightedCode content={line} language={language} />
              </span>
            </div>
          ))}
        </div>
      );
    }

    // Deleted file - show all as removed
    if (diffData.isDeleted) {
      const lines = diffData.oldContent.split('\n');
      return (
        <div className="git-review-inline-diff">
          {lines.map((line, idx) => (
            <div key={idx} className="git-review-inline-diff-line git-review-inline-diff-line-remove">
              <span className="git-review-inline-diff-gutter git-review-inline-diff-gutter-remove">-</span>
              <span className="git-review-inline-diff-line-number">{idx + 1}</span>
              <span className="git-review-inline-diff-content">
                <HighlightedCode content={line} language={language} />
              </span>
            </div>
          ))}
        </div>
      );
    }

    // Unified diff
    return (
      <div className="git-review-inline-diff">
        {unifiedLines.map((line, idx) => {
          const lineClass = line.type === 'add'
            ? 'git-review-inline-diff-line-add'
            : line.type === 'remove'
              ? 'git-review-inline-diff-line-remove'
              : '';

          const gutter = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
          const gutterClass = line.type === 'add'
            ? 'git-review-inline-diff-gutter-add'
            : line.type === 'remove'
              ? 'git-review-inline-diff-gutter-remove'
              : '';

          return (
            <div key={idx} className={`git-review-inline-diff-line ${lineClass}`}>
              <span className={`git-review-inline-diff-gutter ${gutterClass}`}>{gutter}</span>
              <span className="git-review-inline-diff-line-number">
                {line.newLineNumber ?? line.oldLineNumber ?? ''}
              </span>
              <span className="git-review-inline-diff-content">
                <HighlightedCode content={line.content} language={language} />
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderFileContent = () => {
    if (fileContent === null) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
          <Loader2 size={16} className="spinner" />
        </div>
      );
    }

    const lines = fileContent.split('\n');
    return (
      <div className="git-review-inline-diff">
        {lines.map((line, idx) => (
          <div key={idx} className="git-review-inline-diff-line">
            <span className="git-review-inline-diff-gutter"> </span>
            <span className="git-review-inline-diff-line-number">{idx + 1}</span>
            <span className="git-review-inline-diff-content">
              <HighlightedCode content={line} language={language} />
            </span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className="git-review-file-section"
      ref={sectionRef}
      data-filepath={filePath}
    >
      {/* Sentinel for sticky detection */}
      <div ref={sentinelRef} style={{ height: '1px', marginTop: '-1px' }} />

      {/* Header */}
      <div
        ref={headerRef}
        className="git-review-file-header"
        onClick={() => toggleFileExpanded(filePath)}
      >
        <ChevronRight
          size={14}
          className={`git-review-file-header-chevron ${isExpanded ? 'open' : ''}`}
        />
        <span className="git-review-file-header-icon">
          <FileIcon filename={getFilename(filePath)} />
        </span>
        <span className="git-review-file-header-name-group">
          <span className="git-review-file-header-name">{filePath}</span>
          <button
            className="git-review-file-copy-btn"
            onClick={handleCopyPath}
            title="Copy file path"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </span>

        {(stats.added > 0 || stats.removed > 0) && (
          <div className="git-review-file-header-stats">
            {stats.added > 0 && <span className="git-review-file-header-stats-add">+{stats.added}</span>}
            {stats.removed > 0 && <span className="git-review-file-header-stats-remove">-{stats.removed}</span>}
          </div>
        )}

        <div className="git-review-file-header-actions">
          <button
            className={`git-review-file-action-btn ${status === 'staged' ? 'staged' : ''}`}
            onClick={handleApproveToggle}
          >
            {status === 'staged' ? 'Approved' : 'Approve'}
          </button>

          <div className="git-review-file-toggle-group">
            <button
              className={`git-review-file-toggle-btn ${currentViewMode === 'diff' ? 'active' : ''}`}
              onClick={(e) => handleViewModeChange(e, 'diff')}
              title="View diff"
            >
              <Code size={14} />
            </button>
            <button
              className={`git-review-file-toggle-btn ${currentViewMode === 'file' ? 'active' : ''}`}
              onClick={(e) => handleViewModeChange(e, 'file')}
              title="View file"
            >
              <FileText size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className={`git-review-file-content ${!isExpanded ? 'git-review-file-content-collapsed' : ''}`}>
        {isExpanded && (
          selectionContext ? (
            <SelectableCode
              filePath={absoluteFilePath}
              instanceId={selectionContext.instanceId}
            >
              {currentViewMode === 'diff' ? renderDiffContent() : renderFileContent()}
            </SelectableCode>
          ) : (
            currentViewMode === 'diff' ? renderDiffContent() : renderFileContent()
          )
        )}
      </div>
    </div>
  );
});
