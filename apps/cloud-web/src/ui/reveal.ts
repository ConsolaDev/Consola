/**
 * Takes the person to something a link or a note on the page pointed at: scrolls it into view,
 * moves the keyboard to it (without scrolling again) and lights it once, by setting `data-flash`
 * for the element's own stylesheet to animate, and taking it off once the animation ends. Under
 * reduced motion it jumps rather than scrolls, and the stylesheet plays no light.
 */
export function revealElement(element: HTMLElement | undefined): void {
  if (!element) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  element.focus({ preventScroll: true });
  element.removeAttribute('data-flash');
  void element.offsetWidth;
  element.setAttribute('data-flash', '');
  element.addEventListener('animationend', () => element.removeAttribute('data-flash'), {
    once: true,
  });
}
