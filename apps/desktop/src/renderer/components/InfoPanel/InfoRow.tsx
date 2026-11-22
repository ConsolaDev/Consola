import type { ComponentPropsWithRef, ReactNode } from 'react';

interface InfoRowProps {
  icon?: ReactNode;
  /** What the row is about; cut with an ellipsis when it does not fit. */
  label: ReactNode;
  /** A short fact at the row's end, such as a count or the model. */
  value?: ReactNode;
  title?: string;
  /** The button's accessible name, when its text alone does not say what pressing it does. */
  ariaLabel?: string;
  tone?: 'error' | 'muted';
  /** Makes the row a button. A row never navigates: it copies, or opens a tab of the side panel. */
  onActivate?: () => void;
}

/**
 * What a Radix trigger hands the row it wraps (`asChild`): its ref, its
 * handlers, its state and its description. Only a row that is a button
 * takes them.
 */
type TriggerProps = Omit<
  ComponentPropsWithRef<'button'>,
  keyof InfoRowProps | 'children' | 'value'
>;

/**
 * One line of an info panel section. A plain fact is a `<div>`; a row with
 * something behind it is a `<button>`, which is what takes the hover. The
 * `<div>` drops every button prop (a trigger's ref, handlers, state and
 * description, and `ariaLabel`): only a row that does something takes them,
 * so a Radix trigger must wrap a row with `onActivate`.
 */
export function InfoRow({
  icon,
  label,
  value,
  title,
  ariaLabel,
  tone,
  onActivate,
  onClick,
  ...trigger
}: InfoRowProps & TriggerProps) {
  const content = (
    <>
      {icon && (
        <span className="info-row-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="info-row-label">{label}</span>
      {value !== undefined && value !== null && <span className="info-row-value">{value}</span>}
    </>
  );
  if (onActivate) {
    return (
      <button
        {...trigger}
        type="button"
        className="info-row"
        data-tone={tone}
        title={title}
        aria-label={ariaLabel}
        onClick={(event) => {
          onActivate();
          onClick?.(event);
        }}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="info-row" data-tone={tone} title={title}>
      {content}
    </div>
  );
}
