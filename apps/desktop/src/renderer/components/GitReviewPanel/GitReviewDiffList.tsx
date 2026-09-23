import { useRef, useEffect, useCallback, useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useGitStatusStore } from '../../stores/gitStatusStore';
import { useGitReviewStore } from '../../stores/gitReviewStore';
import { GitReviewFileSection } from './GitReviewFileSection';
import { GitFileStatus } from '../../types/electron';

interface GitReviewDiffListProps {
  rootPath: string;
}

export function GitReviewDiffList({ rootPath }: GitReviewDiffListProps) {
  const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const hasAutoExpandedRef = useRef(false);

  const fileStatuses = useGitStatusStore((state) => state.fileStatuses);
  const scrollToFile = useGitReviewStore((state) => state.scrollToFile);
  const setScrollToFile = useGitReviewStore((state) => state.setScrollToFile);
  const expandFiles = useGitReviewStore((state) => state.expandFiles);

  // Memoize sorted files array to prevent recalculation on every render
  const files = useMemo(() => {
    const result: Array<{ path: string; status: GitFileStatus }> = [];
    fileStatuses.forEach((status, path) => {
      result.push({ path, status });
    });
    // Sort: staged first, then alphabetically by path
    return result.sort((a, b) => {
      if (a.status === 'staged' && b.status !== 'staged') return -1;
      if (a.status !== 'staged' && b.status === 'staged') return 1;
      return a.path.localeCompare(b.path);
    });
  }, [fileStatuses]);

  // Auto-expand first 3 files only once when files are loaded
  useEffect(() => {
    if (hasAutoExpandedRef.current || files.length === 0) return;
    hasAutoExpandedRef.current = true;
    const first3 = files.slice(0, 3).map(f => f.path);
    expandFiles(first3);
  }, [files, expandFiles]);

  // Handle scroll to file - scroll within the container to position header at top
  useEffect(() => {
    if (!scrollToFile || !listRef.current) return;

    const element = fileRefs.current.get(scrollToFile);
    if (element) {
      // Get the container and element positions
      const container = listRef.current;
      const elementTop = element.offsetTop;

      // Scroll the container to position the element at the top
      container.scrollTo({
        top: elementTop,
        behavior: 'smooth'
      });

      element.classList.add('highlight');
      setTimeout(() => element.classList.remove('highlight'), 1000);
    }

    // Clear the scroll target
    setScrollToFile(null);
  }, [scrollToFile, setScrollToFile]);

  const setSectionRef = useCallback((filePath: string) => {
    return (el: HTMLDivElement | null) => {
      if (el) {
        fileRefs.current.set(filePath, el);
      } else {
        fileRefs.current.delete(filePath);
      }
    };
  }, []);

  if (files.length === 0) {
    return (
      <div className="git-review-diff-list-empty">
        <CheckCircle2 size={48} strokeWidth={1.5} style={{ opacity: 0.3, marginBottom: 'var(--space-4)' }} />
        <p>No changes to review</p>
        <p>Your working directory is clean</p>
      </div>
    );
  }

  return (
    <div className="git-review-diff-list" ref={listRef}>
      {files.map(({ path, status }) => (
        <GitReviewFileSection
          key={path}
          rootPath={rootPath}
          filePath={path}
          status={status}
          sectionRef={setSectionRef(path)}
        />
      ))}
    </div>
  );
}
