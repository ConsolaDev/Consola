import { usePreviewTabStore, type PreviewTab } from '../../stores/previewTabStore';
import { PreviewTabBar } from './PreviewTabBar';
import { CodeFileView } from '../Views/CodeFileView';
import { MarkdownFileView } from '../Views/MarkdownFileView';
import { DiffView } from '../Views/DiffView';
import { getFileCategory } from '../../utils/fileUtils';
import { FileText } from 'lucide-react';
import './styles.css';

function FileViewer({ tab }: { tab: PreviewTab }) {
  // If this is a diff tab, render DiffView
  if (tab.diffMode) {
    return (
      <DiffView
        rootPath={tab.diffMode.rootPath}
        relativePath={tab.diffMode.relativePath}
        staged={tab.diffMode.staged}
      />
    );
  }

  // Regular file view
  const category = getFileCategory(tab.filePath);

  switch (category) {
    case 'markdown':
      return <MarkdownFileView filePath={tab.filePath} />;
    case 'code':
      return <CodeFileView filePath={tab.filePath} />;
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
          <FileViewer tab={activeTab} />
        ) : (
          <div className="preview-panel-placeholder">
            <p>Select a tab to view</p>
          </div>
        )}
      </div>
    </div>
  );
}
