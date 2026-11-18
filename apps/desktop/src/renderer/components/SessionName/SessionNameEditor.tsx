import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { showToast } from '../../stores/toastStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { renameOutcome } from '../../utils/sessionActions';

interface SessionNameEditorProps {
  /** The name the field opens with. */
  initialName: string;
  className: string;
  ariaLabel: string;
  /** Writes the new name. A rejection is shown to the person, and the field closes. */
  onCommit(name: string): Promise<void>;
  /** The field is finished with, saved or not: the caller shows the name again. */
  onClose(): void;
}

/**
 * The one field that renames a session, wherever its name is shown: the
 * sidebar row and the pane's header. Enter or a blur saves, Escape cancels,
 * and a blank name is refused, since a session needs a name. A rename that
 * failed leaves the old name on screen, which is the truth, and says why.
 *
 * A blur saves only when the person moved focus. The first click of a
 * double-click on a row opens its session, whose terminal mounts and takes
 * focus a moment after this field opened; saving then would close the field
 * under the person's hands and send what they type next to the agent. So
 * until the person presses a pointer outside the field or presses Tab, a blur
 * takes focus back instead.
 */
export function SessionNameEditor({
  initialName,
  className,
  ariaLabel,
  onCommit,
  onClose,
}: SessionNameEditorProps) {
  const [draft, setDraft] = useState(initialName);
  // Compared against the name the field opened with, not the live one: a
  // title that lands while the field is open must not turn the untouched
  // draft into a name the person chose.
  const [openedWith] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set the moment the field's fate is decided. Enter and Escape are followed
  // by a blur as the field goes, and that blur must not save a second time,
  // or save a draft Escape threw away.
  const settledRef = useRef(false);
  // Whether the person did something that moves focus since the field opened.
  const personMovedFocusRef = useRef(false);
  // True while the field is taking focus back, so a thief that insists (a
  // dialog trapping focus takes it straight back) is let go rather than fought.
  const reclaimingRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    // Capture phase, so nothing that stops the event on its way down hides it.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target !== input) personMovedFocusRef.current = true;
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Tab') personMovedFocusRef.current = true;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const save = async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const outcome = renameOutcome(openedWith, draft);
    if (outcome.kind === 'refuse') {
      showToast('A session needs a name.');
    } else if (outcome.kind === 'save') {
      try {
        await onCommit(outcome.name);
      } catch (error) {
        showToast(ipcErrorMessage(error));
      }
    }
    onClose();
  };

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // An input method confirms its candidate with Enter; that picks the
      // characters, it does not finish the name.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      // Escape cancels the rename and nothing else: listeners on the window
      // (the review panel closes on Escape) must not see it.
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  const handleBlur = () => {
    if (settledRef.current) return;
    if (personMovedFocusRef.current || reclaimingRef.current) {
      void save();
      return;
    }
    // Nobody sent focus away. Taking it back while the blur is dispatched
    // cancels the move, so the thief never has it.
    reclaimingRef.current = true;
    try {
      inputRef.current?.focus();
    } finally {
      reclaimingRef.current = false;
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      className={className}
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      // A click in the field is for the field, not whatever it sits in.
      onClick={(event) => event.stopPropagation()}
    />
  );
}
