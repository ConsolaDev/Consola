import { MarkdownFileView } from './MarkdownFileView';
import { CodeFileView } from './CodeFileView';
import { FileText } from 'lucide-react';
import { getFileCategory } from '../../utils/fileUtils';
import './styles.css';

interface ContextPlaceholderProps {
  contextId: string;
  selectedFile?: string | null;
}

function FileViewer({ filePath }: { filePath: string }) {
  const category = getFileCategory(filePath);

  switch (category) {
    case 'markdown':
      return <MarkdownFileView filePath={filePath} />;
    case 'code':
      return <CodeFileView filePath={filePath} />;
    case 'image':
      // Future: Add ImageFileView component
      return (
        <div className="context-placeholder">
          <FileText size={32} />
          <p>Image preview coming soon</p>
          <p className="context-placeholder-hint">{filePath}</p>
        </div>
      );
    default:
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
  if (selectedFile) {
    return <FileViewer filePath={selectedFile} />;
  }

  return (
    <div className="context-placeholder">
      <FileText size={32} />
      <p>Context panel</p>
      <p className="context-placeholder-hint">Select a file to preview</p>
    </div>
  );
}
