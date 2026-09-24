import { useEffect, useRef } from 'react';
import { Picker } from 'emoji-mart';
import data from '@emoji-mart/data';
import { useSettingsStore } from '../../stores/settingsStore';

export default function EmojiGrid({ onSelect }: { onSelect: (emoji: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useSettingsStore(state => state.resolvedTheme);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const picker = new Picker({
      data, theme, autoFocus: true, set: 'native',
      previewPosition: 'none', skinTonePosition: 'search',
      perLine: 8, maxFrequentRows: 2,
      onEmojiSelect: (emoji: { native: string }) => onSelect(emoji.native),
    });
    container.appendChild(picker as unknown as HTMLElement);
    return () => { container.replaceChildren(); };
  }, [theme, onSelect]);
  return <div ref={host} />;
}
