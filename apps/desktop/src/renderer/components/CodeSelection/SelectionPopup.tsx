/**
 * SelectionPopup Component
 *
 * A floating action popup that appears when code text is selected.
 * Provides quick actions like "Add to Chat" with keyboard shortcuts.
 */

import { memo } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { isMac } from '../../utils/platform';

interface SelectionPopupProps {
  /** Position relative to the viewport */
  position: { x: number; y: number };
  /** Called when "Add to Chat" is clicked */
  onAddToChat: () => void;
}

const shortcutKey = isMac ? '⌘' : 'Ctrl+';

export const SelectionPopup = memo(function SelectionPopup({
  position,
  onAddToChat,
}: SelectionPopupProps) {
  return (
    <div
      className="code-selection-popup"
      style={{
        left: position.x,
        top: position.y,
      }}
    >
      <button
        className="code-selection-popup-btn"
        onClick={onAddToChat}
        type="button"
      >
        <MessageSquarePlus size={14} />
        <span>Add to Chat</span>
        <span className="code-selection-shortcut">{shortcutKey}L</span>
      </button>
    </div>
  );
});
