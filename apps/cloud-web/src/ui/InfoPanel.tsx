import { ChevronRight, ExternalLink } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import './InfoPanel.css';

/*
 * The desktop's info panel (`components/InfoPanel/`), redrawn for the web: beside what a page is
 * about, a glance at its facts, in sections that fold, each a heading over short rows. A row
 * states one fact: an icon, what it is about, and a short value at its end. It takes no keyboard
 * by itself, and only a row with something behind it is a link.
 */

/** The panel: its sections, in the order the page gives them. */
export function InfoPanel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="info-panel" aria-label={label}>
      {children}
    </aside>
  );
}

/**
 * A section: a heading that folds it, then its rows. A folded section renders neither its
 * actions nor its rows. Which are folded is the page's to keep.
 */
export function InfoSection({
  title,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Controls beside the heading, drawn only while the section is open. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  const bodyId = useId();
  return (
    <section className="info-section" aria-labelledby={headingId}>
      <div className="info-section-header">
        <h2 className="info-section-heading">
          <button
            type="button"
            id={headingId}
            className="info-section-toggle"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            onClick={onToggle}
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

/**
 * One line of a section. A plain fact is a `<div>`; a row with a page behind it is a link, which
 * is what takes the hover: another page of this app (`href`), or one elsewhere (`external`),
 * which opens in a tab of its own.
 */
export function InfoRow({
  icon,
  label,
  value,
  title,
  tone,
  href,
  external = false,
  onFollow,
}: {
  icon?: ReactNode;
  /** What the row is about; cut with an ellipsis when it does not fit. */
  label: ReactNode;
  /** A short fact at the row's end, such as a count or a time. */
  value?: ReactNode;
  title?: string;
  tone?: 'muted' | 'error' | 'warning';
  href?: string;
  external?: boolean;
  /**
   * What a plain click on a link row does instead of following it, on this page: a click with a
   * modifier (a new tab, a new window) still follows `href`.
   */
  onFollow?: () => void;
}) {
  const content = (
    <>
      {icon && (
        <span className="info-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="info-row-label">{label}</span>
      {value !== undefined && value !== null && value !== '' && (
        <span className="info-row-value">{value}</span>
      )}
      {href && external && (
        <>
          <ExternalLink size={12} className="info-row-out" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </>
      )}
    </>
  );
  if (href) {
    return (
      <a
        className="info-row"
        data-tone={tone}
        title={title}
        href={href}
        {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        onClick={(event) => {
          if (!onFollow || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onFollow();
        }}
      >
        {content}
      </a>
    );
  }
  return (
    <div className="info-row" data-tone={tone} title={title}>
      {content}
    </div>
  );
}

/** A quiet state in a section: one muted sentence, wrapped. */
export function InfoQuiet({ children }: { children: ReactNode }) {
  return <p className="info-quiet">{children}</p>;
}
