/**
 * The navigation settings mark: two sliders, the top one set high and the
 * bottom one low, drawn on Lucide's grid and stroke so it sits beside the
 * search glass as one family.
 *
 * Each knob travels a step along its track while the button is pointed at or
 * its menu is open (`.sidebar-navigation-settings` in styles.css), so the
 * glyph does the thing it names. A track ends where its knob begins, so it is
 * drawn as a dash that shortens as the knob slides over it, never as a line
 * the hollow knob would show through.
 */
export function NavigationGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg
      className="navigation-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Drawn from the fixed end toward the knob, so the dash shortens at the knob's side. */}
      <path className="navigation-glyph-track navigation-glyph-track--top" d="M3 7H14" />
      <circle className="navigation-glyph-knob navigation-glyph-knob--top" cx="17" cy="7" r="3" />
      <path className="navigation-glyph-track navigation-glyph-track--bottom" d="M21 17H10" />
      <circle
        className="navigation-glyph-knob navigation-glyph-knob--bottom"
        cx="7"
        cy="17"
        r="3"
      />
    </svg>
  );
}
