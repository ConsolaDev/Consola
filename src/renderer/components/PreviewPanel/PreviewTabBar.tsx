import { useState, useRef, useEffect } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { X } from 'lucide-react';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { FileIcon } from '../FileExplorer/FileIcon';

interface TabTooltipProps {
  filePath: string;
  targetRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
}

function TabTooltip({ filePath, targetRef, visible }: TabTooltipProps) {
  if (!visible || !targetRef.current) return null;

  const rect = targetRef.current.getBoundingClientRect();

  return (
    <div
      className="preview-tab-tooltip"
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.bottom + 6,
      }}
    >
      {filePath}
    </div>
  );
}

interface PreviewTabItemProps {
  tab: { id: string; filePath: string; filename: string };
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCloseAll: () => void;
  hasOtherTabs: boolean;
  hasTabsToRight: boolean;
}

function PreviewTabItem({
  tab,
  isActive,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  hasOtherTabs,
  hasTabsToRight,
}: PreviewTabItemProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const tabRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    timeoutRef.current = setTimeout(() => {
      setShowTooltip(true);
    }, 1000);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setShowTooltip(false);
  };

  const hideTooltip = () => {
    setShowTooltip(false);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      <ContextMenu.Root onOpenChange={(open) => open && hideTooltip()}>
        <ContextMenu.Trigger asChild>
          <div
            ref={tabRef}
            className={`preview-tab ${isActive ? 'active' : ''}`}
            onClick={onSelect}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <FileIcon filename={tab.filename} className="preview-tab-icon" />
            <span className="preview-tab-name">{tab.filename}</span>
            <button
              className="preview-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={`Close ${tab.filename}`}
            >
              <X size={12} />
            </button>
          </div>
        </ContextMenu.Trigger>

        <ContextMenu.Portal>
          <ContextMenu.Content className="dropdown-content dropdown-content-compact" sideOffset={4}>
            <ContextMenu.Item className="dropdown-item" onSelect={onClose}>
              Close
            </ContextMenu.Item>
            <ContextMenu.Item
              className="dropdown-item"
              onSelect={onCloseOthers}
              disabled={!hasOtherTabs}
            >
              Close Others
            </ContextMenu.Item>
            <ContextMenu.Item
              className="dropdown-item"
              onSelect={onCloseToRight}
              disabled={!hasTabsToRight}
            >
              Close to the Right
            </ContextMenu.Item>
            <ContextMenu.Separator className="dropdown-separator" />
            <ContextMenu.Item className="dropdown-item" onSelect={onCloseAll}>
              Close All
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <TabTooltip filePath={tab.filePath} targetRef={tabRef} visible={showTooltip} />
    </>
  );
}

export function PreviewTabBar() {
  const tabs = usePreviewTabStore((state) => state.tabs);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);
  const setActiveTab = usePreviewTabStore((state) => state.setActiveTab);
  const closeTab = usePreviewTabStore((state) => state.closeTab);
  const closeAllTabs = usePreviewTabStore((state) => state.closeAllTabs);
  const closeOtherTabs = usePreviewTabStore((state) => state.closeOtherTabs);
  const closeTabsToRight = usePreviewTabStore((state) => state.closeTabsToRight);

  if (tabs.length === 0) return null;

  return (
    <div className="preview-tab-bar">
      {tabs.map((tab, index) => (
        <PreviewTabItem
          key={tab.id}
          tab={tab}
          isActive={activeTabId === tab.id}
          onSelect={() => setActiveTab(tab.id)}
          onClose={() => closeTab(tab.id)}
          onCloseOthers={() => closeOtherTabs(tab.id)}
          onCloseToRight={() => closeTabsToRight(tab.id)}
          onCloseAll={closeAllTabs}
          hasOtherTabs={tabs.length > 1}
          hasTabsToRight={index < tabs.length - 1}
        />
      ))}
    </div>
  );
}
