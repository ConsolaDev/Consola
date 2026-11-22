/**
 * Consola's C, the app icon's letter alone (`apps/desktop/src/renderer/public/icon.svg`): a ring
 * three-quarters round, its ends cut on the diagonal. A block cursor waits in its mouth and
 * blinks a few times when the mark is pointed at or focused (`.brand` in `styles.css`), the
 * console the name comes from. It is decoration: whatever holds it carries the name.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="224 224 576 576" aria-hidden="true">
      <path
        fill="currentColor"
        d="M 724 314 A 280 280 0 1 0 724 710 L 630 616 A 148 148 0 1 1 630 408 Z"
      />
      <rect className="brand-cursor" x="684" y="452" width="64" height="120" rx="10" />
    </svg>
  );
}
