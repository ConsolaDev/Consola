import { MarkdownFileView } from './MarkdownFileView';
import { FileText } from 'lucide-react';
import './styles.css';

interface ContextPlaceholderProps {
  contextId: string;
  selectedFile?: string;
}

/**
 * Get the appropriate viewer component for a file based on its extension
 */
function getViewerForFile(filePath: string) {
  const extension = filePath.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'md':
    case 'markdown':
      return <MarkdownFileView filePath={filePath} />;
    default:
      // For now, show a placeholder for unsupported file types
      return (
        <div className="context-placeholder">
          <FileText size={32} />
          <p>Preview not available for this file type</p>
          <p className="context-placeholder-hint">{filePath}</p>
        </div>
      );
  }
}

export function ContextPlaceholder({ contextId, selectedFile }: ContextPlaceholderProps) {
  // If a file is selected, show the appropriate viewer
  if (selectedFile) {
    return getViewerForFile(selectedFile);
  }

  // Default placeholder when no file is selected
  return (
    <div className="context-placeholder">
      <FileText size={32} />
      <p>Context panel</p>
      <p className="context-placeholder-hint">Select a file to preview</p>
    </div>
  );
}
