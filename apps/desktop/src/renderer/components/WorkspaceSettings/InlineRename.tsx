import { useEffect, useRef, useState } from 'react';

interface InlineRenameProps {
  value: string;
  ariaLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}

/**
 * An input that replaces a row's name while renaming: Enter or blur commits,
 * Escape reverts. A rename that failed leaves the old name on screen, which
 * is the truth — same contract as the sidebar's session rename.
 */
export function InlineRename({ value, ariaLabel, onSubmit, onClose }: InlineRenameProps) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set the moment the field's fate is decided. Enter and Escape are both
  // followed by a blur (focus moves as the input goes), and that blur must
  // not commit a second time — or worse, commit a draft Escape discarded.
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = draft.trim();
    try {
      if (trimmed && trimmed !== value) {
        await onSubmit(trimmed);
      }
    } finally {
      onClose();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      void commit();
    } else if (event.key === 'Escape') {
      settledRef.current = true;
      onClose();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className="ws-rename-input"
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void commit()}
      onKeyDown={handleKeyDown}
    />
  );
}
