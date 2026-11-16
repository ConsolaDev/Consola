import { lazy, Suspense, useCallback, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Boxes } from 'lucide-react';
import './styles.css';

const EmojiGrid = lazy(() => import('./EmojiGrid'));

export function GroupEmojiPicker({ value, onChange, disabled, subject = 'group' }: {
  /** What the emoji belongs to, for the accessible names: a group, or a label. */
  subject?: string;
  value?: string;
  onChange: (emoji: string | undefined) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const select = useCallback((emoji: string) => {
    onChange(emoji);
    setOpen(false);
  }, [onChange]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="group-emoji-trigger" disabled={disabled}
          aria-label={value ? `Change ${subject} emoji` : `Choose ${subject} emoji`} title={`Choose ${subject} emoji`}>
          <span aria-hidden="true">{value || <Boxes size={18} />}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="group-emoji-popover" sideOffset={6} align="start"
          collisionPadding={12} aria-label={`${subject[0].toUpperCase()}${subject.slice(1)} emoji`} onOpenAutoFocus={event => event.preventDefault()}>
          <Suspense fallback={<p className="group-emoji-loading" role="status">Loading emojis…</p>}>
            <EmojiGrid onSelect={select} />
          </Suspense>
          <button type="button" className="group-emoji-reset" disabled={!value}
            onClick={() => { onChange(undefined); setOpen(false); }}>
            Remove emoji
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
