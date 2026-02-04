import './styles.css';

interface ContextPlaceholderProps {
  contextId: string;
}

export function ContextPlaceholder({ contextId }: ContextPlaceholderProps) {
  return (
    <div className="context-placeholder">
      <p>Context panel</p>
      <p className="context-placeholder-hint">Files and context coming soon</p>
    </div>
  );
}
