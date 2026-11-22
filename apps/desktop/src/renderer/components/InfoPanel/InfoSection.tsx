import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { InfoSectionId } from '../../infoPanel/sections';
import { isInfoSectionOpen, useSettingsStore } from '../../stores/settingsStore';

interface InfoSectionProps {
  id: InfoSectionId;
  title: string;
  /** Controls beside the heading, drawn only while the section is open. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A section of the info panel: a heading that folds it, then its rows. Which
 * sections are folded is remembered (`settingsStore.infoSectionOpen`).
 *
 * A folded section renders neither its actions nor its body, so whatever
 * they read or watch never starts while it is folded: give a section's rows
 * as a component, whose hooks then run only while it is open.
 */
export function InfoSection({ id, title, actions, children }: InfoSectionProps) {
  const open = useSettingsStore((state) => isInfoSectionOpen(state.infoSectionOpen, id));
  const toggleInfoSection = useSettingsStore((state) => state.toggleInfoSection);
  const headingId = useId();
  const bodyId = useId();

  return (
    <section className="info-section" aria-labelledby={headingId} data-section={id}>
      <div className="info-section-header">
        <h2 className="info-section-heading">
          <button
            type="button"
            id={headingId}
            className="info-section-toggle"
            aria-expanded={open}
            // Folded, the body is not rendered, so it names nothing.
            aria-controls={open ? bodyId : undefined}
            onClick={() => toggleInfoSection(id)}
          >
            <ChevronRight size={12} className="info-section-chevron" aria-hidden="true" />
            {title}
          </button>
        </h2>
        {open && actions && <div className="info-section-actions">{actions}</div>}
      </div>
      {open && (
        <div id={bodyId} className="info-section-body">
          {children}
        </div>
      )}
    </section>
  );
}
