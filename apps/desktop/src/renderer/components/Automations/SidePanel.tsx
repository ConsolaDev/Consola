import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import type { Workspace } from '../../../shared/workspace';
import { useAutomationsStore, type AutomationsPanel } from '../../stores/automationsStore';
import { AutomationDetails } from './AutomationDetails';
import { NewAutomation } from './NewAutomation';
import { RunDetails } from './RunDetails';
import { runTitle } from './presentation';

/**
 * The one panel beside the dashboard: a run, an automation, or a new
 * automation. It slides in from the right over about two thirds of it, and
 * leaves the rest of the dashboard usable — opening another run swaps it.
 *
 * ✕ or Escape closes it; Escape is the dashboard's (`AutomationsView`), so
 * it works wherever on the dashboard focus is. Focus moves in when it opens,
 * and back where it was when it closes.
 */
export function SidePanel({ workspace, panel }: { workspace: Workspace; panel: AutomationsPanel }) {
  const closePanel = useAutomationsStore((state) => state.closePanel);
  const title = usePanelTitle(workspace.id, panel);
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const panelKey = panel.kind === 'run' ? `run:${panel.runId}` : panel.kind === 'automation' ? `automation:${panel.name}` : 'new';

  // Declared before the effect that moves focus, so it sees where focus was.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    (element.querySelector<HTMLElement>('[data-autofocus]') ?? element).focus();
  }, [panelKey]);

  // Focus in the panel stays in it when what held it goes — Start gives way
  // to Stop, a button disables while it works — or the keyboard would be
  // left on nothing. Only while the person has not moved on: a click or Tab
  // outside lets it go.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let inside = true;
    const onFocusIn = () => {
      inside = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !element.contains(event.relatedTarget)) inside = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !element.contains(event.target)) inside = false;
    };
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (inside && (active === null || active === document.body)) element.focus({ preventScroll: true });
    });
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    return () => {
      observer.disconnect();
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  return (
    <aside
      ref={ref}
      className="automations-side-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="automations-side-panel-header">
        <h2 id={titleId} className="automations-side-panel-title">
          {title}
        </h2>
        <button
          type="button"
          className="automations-icon-button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={closePanel}
        >
          <X size={14} />
        </button>
      </header>
      <div className="automations-side-panel-body">
        {panel.kind === 'run' && <RunDetails key={panel.runId} workspace={workspace} runId={panel.runId} />}
        {panel.kind === 'automation' && <AutomationDetails key={panel.name} workspace={workspace} name={panel.name} />}
        {panel.kind === 'new' && <NewAutomation workspace={workspace} basis={panel.basis} />}
      </div>
    </aside>
  );
}

/** A run is titled by what ran it, an automation by its name. */
function usePanelTitle(workspaceId: string, panel: AutomationsPanel): string {
  const run = useAutomationsStore((state) =>
    panel.kind === 'run' ? state.snapshots[workspaceId]?.runs.find((candidate) => candidate.id === panel.runId) : undefined
  );
  if (panel.kind === 'run') return run ? runTitle(run) : 'Run';
  if (panel.kind === 'automation') return panel.name;
  return panel.basis && 'automation' in panel.basis ? `Change ${panel.basis.automation}` : 'New automation';
}
