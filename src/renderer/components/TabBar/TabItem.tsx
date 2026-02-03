import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X, Home, FileText, Folder } from 'lucide-react';
import { type Tab } from '../../stores/tabStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onClose: () => void;
  onClick: () => void;
}

export function TabItem({ tab, isActive, onClose, onClick }: TabItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const getTabLabel = (): string => {
    switch (tab.type) {
      case 'home':
        return 'Home';
      case 'workspace': {
        const workspace = workspaces.find((w) => w.id === tab.targetId);
        return workspace?.name ?? 'Workspace';
      }
      case 'project': {
        const workspace = workspaces.find((w) => w.id === tab.workspaceId);
        const project = workspace?.projects.find((p) => p.id === tab.targetId);
        return project?.name ?? 'Project';
      }
      default:
        return 'Tab';
    }
  };

  const getTabIcon = () => {
    switch (tab.type) {
      case 'home':
        return <Home size={14} />;
      case 'workspace':
        return <FileText size={14} />;
      case 'project':
        return <Folder size={14} />;
      default:
        return null;
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tab-item ${isActive ? 'active' : ''}`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <span className="tab-item-icon">{getTabIcon()}</span>
      <span className="tab-item-label">{getTabLabel()}</span>
      {tab.type !== 'home' && (
        <button
          className="tab-item-close"
          onClick={handleClose}
          aria-label="Close tab"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
