import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { FileExplorer } from '../FileExplorer';
import { PreviewPanel } from '../PreviewPanel';

/**
 * The Files tab: the session's folder as a tree, and beside it the files
 * chosen there, each in a preview tab. The split between the two is saved
 * like every other size, whatever the side panel remembers.
 */
export function FilesTab({ rootPath }: { rootPath: string }) {
  const openFile = usePreviewTabStore((state) => state.openFile);
  const activePreviewTabId = usePreviewTabStore((state) => state.activeTabId);
  const hasPreviews = usePreviewTabStore((state) => state.tabs.length > 0);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'files-tab',
    storage: localStorage,
  });

  return (
    <Group orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <Panel id="files-tree" defaultSize="40%" minSize="160px">
        <FileExplorer
          rootPath={rootPath}
          selectedPath={activePreviewTabId}
          onSelectFile={openFile}
        />
      </Panel>
      <Separator className="resize-handle" />
      <Panel id="files-previews" minSize="200px">
        {hasPreviews ? (
          <PreviewPanel />
        ) : (
          <p className="files-tab-placeholder">Choose a file to preview it here.</p>
        )}
      </Panel>
    </Group>
  );
}
