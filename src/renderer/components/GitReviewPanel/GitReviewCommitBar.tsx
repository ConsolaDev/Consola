import { useMemo, memo } from 'react';
import { Loader2, Sparkles, GitCommit } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';

interface GitReviewCommitBarProps {
  rootPath: string;
}

export const GitReviewCommitBar = memo(function GitReviewCommitBar({ rootPath }: GitReviewCommitBarProps) {
  const commitMessage = useGitReviewStore((state) => state.commitMessage);
  const setCommitMessage = useGitReviewStore((state) => state.setCommitMessage);
  const isGeneratingMessage = useGitReviewStore((state) => state.isGeneratingMessage);
  const isCommitting = useGitReviewStore((state) => state.isCommitting);
  const error = useGitReviewStore((state) => state.error);
  const generateCommitMessage = useGitReviewStore((state) => state.generateCommitMessage);
  const commitStaged = useGitReviewStore((state) => state.commitStaged);

  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);

  // Memoize staged count to prevent recalculation on every render
  const stagedCount = useMemo(() => {
    let count = 0;
    fileStatuses.forEach((status) => {
      if (status === 'staged') count++;
    });
    return count;
  }, [fileStatuses]);

  const handleGenerate = () => {
    void generateCommitMessage(rootPath);
  };

  const handleCommit = () => {
    if (!commitMessage.trim() || stagedCount === 0) return;
    void commitStaged(rootPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleCommit();
    }
    if (e.key === 'g' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleGenerate();
    }
  };

  return (
    <div className="git-review-commit-bar">
      <div className="git-review-commit-input-wrapper">
        <label className="git-review-commit-label">
          Commit message {stagedCount > 0 && `(${stagedCount} file${stagedCount === 1 ? '' : 's'} approved)`}
        </label>
        <textarea
          className="git-review-commit-input"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Enter commit message..."
          rows={2}
        />
        {error && (
          <span style={{ fontSize: '11px', color: 'var(--color-git-deleted)', marginTop: '4px' }}>
            {error}
          </span>
        )}
      </div>

      <div className="git-review-commit-actions">
        <button
          className="git-review-commit-btn generate"
          onClick={handleGenerate}
          disabled={isGeneratingMessage || stagedCount === 0}
          title="Generate commit message (Cmd+G)"
        >
          {isGeneratingMessage ? (
            <Loader2 size={14} className="spinner" />
          ) : (
            <Sparkles size={14} />
          )}
          Generate
        </button>

        <button
          className="git-review-commit-btn commit"
          onClick={handleCommit}
          disabled={isCommitting || !commitMessage.trim() || stagedCount === 0}
          title="Commit changes (Cmd+Enter)"
        >
          {isCommitting ? (
            <Loader2 size={14} className="spinner" />
          ) : (
            <GitCommit size={14} />
          )}
          Commit
        </button>
      </div>
    </div>
  );
});
