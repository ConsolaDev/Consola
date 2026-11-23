import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../services/clipboard';

/** How long the check stays after a copy before the button offers to copy again. */
const COPIED_MS = 1600;

type Outcome = 'copied' | 'refused' | null;

/**
 * A workspace's slug, which copies itself when pressed. The copy icon turns into a check for a
 * moment, and a screen reader hears "Copied". A browser that refuses the copy is said to, so the
 * person knows to select the slug instead.
 */
export function CopySlug({ slug }: { slug: string }) {
  const [outcome, setOutcome] = useState<Outcome>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const copied = await copyText(slug);
    setOutcome(copied ? 'copied' : 'refused');
    clearTimeout(timer.current);
    if (copied) timer.current = setTimeout(() => setOutcome(null), COPIED_MS);
  }

  return (
    <span className="copy-slug">
      <button
        type="button"
        className="slug"
        data-copied={outcome === 'copied' || undefined}
        onClick={() => void copy()}
        aria-label={`Copy the slug, ${slug}`}
      >
        <span className="slug-value">{slug}</span>
        <span className="slug-icon" aria-hidden="true">
          {outcome === 'copied' ? <Check key="check" size={12} /> : <Copy key="copy" size={12} />}
        </span>
      </button>
      <span className={outcome === 'refused' ? 'slug-refused' : 'sr-only'} role="status">
        {outcome === 'copied'
          ? 'Copied'
          : outcome === 'refused'
            ? 'The browser didn’t allow copying.'
            : ''}
      </span>
    </span>
  );
}
