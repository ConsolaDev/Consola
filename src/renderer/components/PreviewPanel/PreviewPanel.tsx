import { usePreviewTabStore } from '../../stores/previewTabStore';
import { PreviewTabBar } from './PreviewTabBar';
import { CodeFileView } from '../Views/CodeFileView';
import { MarkdownFileView } from '../Views/MarkdownFileView';
import { getFileCategory } from '../../utils/fileUtils';
import { FileText } from 'lucide-react';
import './styles.css';

function FileViewer({ filePath }: { filePath: string }) {
  const category = getFileCategory(filePath);

  switch (category) {
    case 'markdown':
      return <MarkdownFileView filePath={filePath} />;
    case 'code':
      return <CodeFileView filePath={filePath} />;
    case 'image':
      return (
        <div className="preview-panel-placeholder">
          <FileText size={32} />
          <p>Image preview coming soon</p>
        </div>
      );
    default:
      return (
        <div className="preview-panel-placeholder">
          <FileText size={32} />
          <p>Preview not available for this file type</p>
        </div>
      );
  }
}

export function PreviewPanel() {
  const tabs = usePreviewTabStore((state) => state.tabs);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Don't render anything if no tabs
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="preview-panel">
      <PreviewTabBar />
      <div className="preview-panel-content">
        {activeTab ? (
          <FileViewer filePath={activeTab.filePath} />
        ) : (
          <div className="preview-panel-placeholder">
            <p>Select a tab to view</p>
          </div>
        )}
      </div>
    </div>
  );
}
