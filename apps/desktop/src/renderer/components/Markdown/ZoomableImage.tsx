import { createContext, useContext, useState, type ComponentProps, type MouseEvent, type ReactNode } from 'react';
import type { ViewedImage } from '../ImageViewer';

/** Opens an image in the viewer; null where images are not zoomable. */
export const OpenImageContext = createContext<((image: ViewedImage) => void) | null>(null);

/**
 * True inside an element that already decides what a click does: a link, or
 * a `<picture>` that is itself the trigger. So a badge that links somewhere
 * keeps its link, and a picture's `<img>` stays its direct child, which the
 * browser needs to choose between its sources.
 */
const ClickClaimedContext = createContext(false);

export function ClaimsClick({ children }: { children: ReactNode }) {
  return <ClickClaimedContext.Provider value>{children}</ClickClaimedContext.Provider>;
}

/** What the page shows right now, the source a `<picture>` picked included, or null if it never loaded. */
function viewedImage(img: HTMLImageElement): ViewedImage | null {
  if (!img.complete || img.naturalWidth === 0 || !img.currentSrc) return null;
  return { src: img.currentSrc, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight };
}

/**
 * Makes its image open in the viewer when clicked. A real button, so it is
 * reachable by keyboard and announced as something that opens a dialog.
 */
export function ImageZoomTrigger({ label, children }: { label: string; children: ReactNode }) {
  const open = useContext(OpenImageContext);
  const claimed = useContext(ClickClaimedContext);
  if (!open || claimed) return <>{children}</>;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const img = event.currentTarget.querySelector('img');
    const image = img && viewedImage(img);
    if (!image) return;
    // A click does not focus a button everywhere; the viewer returns focus to whatever had it.
    event.currentTarget.focus();
    open(image);
  };
  return (
    <button type="button" className="markdown-image-zoom" aria-label={label} aria-haspopup="dialog" onClick={onClick}>
      <ClaimsClick>{children}</ClaimsClick>
    </button>
  );
}

/** An image that opens in the viewer, unless it has no source or failed to load: then only its alt text shows. */
export function ZoomableImage({ src, alt, ...props }: ComponentProps<'img'>) {
  const [failed, setFailed] = useState(false);
  const img = <img {...props} src={src} alt={alt} onError={() => setFailed(true)} />;
  if (!src || failed) return img;
  return <ImageZoomTrigger label={alt ? `Enlarge image: ${alt}` : 'Enlarge image'}>{img}</ImageZoomTrigger>;
}
