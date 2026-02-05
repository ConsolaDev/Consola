import { X } from 'lucide-react';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { FileIcon } from '../FileExplorer/FileIcon';

export function PreviewTabBar() {
  const tabs = usePreviewTabStore((state) => state.tabs);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);
  const setActiveTab = usePreviewTabStore((state) => state.setActiveTab);
  const closeTab = usePreviewTabStore((state) => state.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="preview-tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`preview-tab ${activeTabId === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <FileIcon filename={tab.filename} className="preview-tab-icon" />
          <span className="preview-tab-name">{tab.filename}</span>
          <button
            className="preview-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
            aria-label={`Close ${tab.filename}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
