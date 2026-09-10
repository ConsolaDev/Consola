import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, KeyboardSensor,
  closestCenter, defaultDropAnimationSideEffects, useSensor, useSensors,
  type DragEndEvent, type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { dialogBridge } from '../../services/dialogBridge';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { isMac } from '../../utils/platform';
import { WorkspaceIcon } from '../WorkspaceIcon';

const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const modifiers = [verticalOnly];
const dropAnimation = {
  duration: 180,
  easing: EASING,
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
};

export function WorkspaceRail() {
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const reducedMotion = useReducedMotion();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragged = workspaces.find(workspace => workspace.id === draggedId);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: reducedMotion ? 'auto' : 'smooth',
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    })
  );

  const addWorkspace = async () => {
    const folder = await dialogBridge.selectFolder();
    if (!folder) return;
    const workspace = await useWorkspaceStore.getState().createWorkspace(folder.name, folder.path, folder.isGitRepo);
    await useNavigationStore.getState().setActiveWorkspace(workspace.id);
  };

  // Keep the overlay lifted until main has persisted and broadcast the move.
  // The rail, tooltip numbers, and global shortcuts then update together.
  const saveDrop = async ({ active, over }: DragEndEvent): Promise<boolean> => {
    if (!over || active.id === over.id) return false;
    const current = useWorkspaceStore.getState().workspaces;
    const from = current.findIndex(workspace => workspace.id === active.id);
    const to = current.findIndex(workspace => workspace.id === over.id);
    if (from < 0 || to < 0) return true;
    const reordered = arrayMove(current, from, to);
    try {
      await useWorkspaceStore.getState().moveWorkspace(String(active.id), reordered[to + 1]?.id ?? null);
      return false;
    } catch {
      setError('Could not save workspace order. Try dragging again.');
      return true;
    }
  };

  const nameOf = (id: string | number) => workspaces.find(workspace => workspace.id === id)?.name ?? 'Workspace';

  return (
    <Tooltip.Provider delayDuration={200}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={modifiers}
        cancelDrop={saveDrop}
        onDragStart={({ active }) => { setError(null); setDraggedId(String(active.id)); }}
        onDragEnd={() => setDraggedId(null)}
        onDragCancel={() => setDraggedId(null)}
        accessibility={{
          screenReaderInstructions: {
            draggable: 'Press Space to pick up a workspace, Up or Down to move it, Space to drop, or Escape to cancel. Press Enter to switch workspace.',
          },
          announcements: {
            onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}. Use Up or Down to reorder.`,
            onDragOver: ({ active, over }) => over
              ? `${nameOf(active.id)}, position ${workspaces.findIndex(workspace => workspace.id === over.id) + 1} of ${workspaces.length}.`
              : undefined,
            onDragEnd: ({ active }) => `${nameOf(active.id)} placed at position ${workspaces.findIndex(workspace => workspace.id === active.id) + 1}. Workspace shortcuts updated.`,
            onDragCancel: () => 'Reordering canceled. Workspace order unchanged.',
          },
        }}
      >
        <nav className="workspace-rail" aria-label="Workspaces" data-reordering={draggedId ? '' : undefined}>
          <SortableContext items={workspaces.map(workspace => workspace.id)} strategy={verticalListSortingStrategy}>
            {workspaces.map((workspace, index) => (
              <SortableWorkspace key={workspace.id} workspace={workspace} index={index}
                canReorder={workspaces.length > 1} reordering={draggedId !== null} reducedMotion={reducedMotion} />
            ))}
          </SortableContext>
          <button className="workspace-rail-add" aria-label="Add workspace" title="Add workspace" onClick={() => void addWorkspace()}>
            <Plus size={24} />
          </button>
        </nav>
        {createPortal(
          <DragOverlay dropAnimation={reducedMotion ? null : dropAnimation} zIndex={250}>
            {dragged && <div className="workspace-drag-overlay" aria-hidden="true">
              <WorkspaceIcon icon={dragged.icon} name={dragged.name} size={32} borderRadius={8} />
            </div>}
          </DragOverlay>, document.body
        )}
      </DndContext>
      {error && createPortal(
        <div className="workspace-reorder-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss workspace order error" onClick={() => setError(null)}><X size={14} /></button>
        </div>, document.body
      )}
    </Tooltip.Provider>
  );
}

function SortableWorkspace({ workspace, index, canReorder, reordering, reducedMotion }: {
  workspace: Workspace; index: number; canReorder: boolean; reordering: boolean; reducedMotion: boolean;
}) {
  const activeWorkspaceId = useNavigationStore(state => state.activeWorkspaceId);
  const setActiveWorkspace = useNavigationStore(state => state.setActiveWorkspace);
  const terminals = useTerminalStore(state => state.terminals);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: workspace.id,
    disabled: !canReorder,
    transition: reducedMotion ? null : { duration: 180, easing: EASING },
  });
  const needsAttention = workspace.sessions.some(
    session => sessionStatusFor(terminals[session.instanceId]) === 'needs-attention'
  );
  const shortcut = index < 9 ? index + 1 : null;

  return (
    <Tooltip.Root open={!reordering && tooltipOpen} onOpenChange={setTooltipOpen}>
      <Tooltip.Trigger asChild>
        <button
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className="workspace-rail-item"
          style={{ transform: CSS.Transform.toString(transform), transition }}
          data-dragging={isDragging ? '' : undefined}
          data-sortable={canReorder ? '' : undefined}
          aria-disabled={undefined}
          aria-label={workspace.name}
          aria-current={workspace.id === activeWorkspaceId ? 'true' : undefined}
          aria-description={needsAttention ? 'A prompt needs your attention' : undefined}
          aria-keyshortcuts={shortcut ? `${isMac ? 'Meta' : 'Control'}+${shortcut}` : undefined}
          onClick={() => { if (!reordering) void setActiveWorkspace(workspace.id); }}
        >
          <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={32} borderRadius={8} />
          {needsAttention && <span className="workspace-rail-attention" aria-hidden="true" />}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="workspace-tooltip" side="right" sideOffset={12} collisionPadding={8}>
          <span className="workspace-tooltip-details">
            <span className="workspace-tooltip-name">{workspace.name}</span>
            {needsAttention && <span className="workspace-tooltip-attention">A prompt needs your attention</span>}
          </span>
          {shortcut && <span className="workspace-tooltip-shortcut">
            <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>{shortcut}</kbd>
          </span>}
          <Tooltip.Arrow className="workspace-tooltip-arrow" width={10} height={6} />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
