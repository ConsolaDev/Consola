import { useState, useMemo, memo } from 'react';
import { Loader2, Sparkles, GitCommit } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { gitBridge } from '../../services/gitBridge';

interface GitReviewCommitBarProps {
  rootPath: string;
}

export const GitReviewCommitBar = memo(function GitReviewCommitBar({ rootPath }: GitReviewCommitBarProps) {
  const [error, setError] = useState<string | null>(null);

  const commitMessage = useGitReviewStore((state) => state.commitMessage);
  const setCommitMessage = useGitReviewStore((state) => state.setCommitMessage);
  const isGeneratingMessage = useGitReviewStore((state) => state.isGeneratingMessage);
  const setGeneratingMessage = useGitReviewStore((state) => state.setGeneratingMessage);
  const isCommitting = useGitReviewStore((state) => state.isCommitting);
  const setCommitting = useGitReviewStore((state) => state.setCommitting);

  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const refresh = useGitStatusStore((state) => state.refresh);

  // Memoize staged count to prevent recalculation on every render
  const stagedCount = useMemo(() => {
    let count = 0;
    fileStatuses.forEach((status) => {
      if (status === 'staged') count++;
    });
    return count;
  }, [fileStatuses]);

  const handleGenerate = async () => {
    setError(null);
    setGeneratingMessage(true);

    try {
      const result = await gitBridge.generateCommitMessage(rootPath);
      if (result?.message) {
        setCommitMessage(result.message);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate message');
    } finally {
      setGeneratingMessage(false);
    }
  };

  const handleCommit = async () => {
    if (!commitMessage.trim() || stagedCount === 0) return;

    setError(null);
    setCommitting(true);

    try {
      const result = await gitBridge.commit(rootPath, commitMessage);
      if (result?.success) {
        setCommitMessage('');
        await refresh(rootPath);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to commit');
    } finally {
      setCommitting(false);
    }
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
