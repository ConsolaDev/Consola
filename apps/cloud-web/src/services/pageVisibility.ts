/*
 * Whether the page is in front of the person: a hidden tab reads nothing, so the Runs pages stop
 * refreshing while it is hidden and refresh at once when it shows again.
 */

export function isPageVisible(): boolean {
  return document.visibilityState !== 'hidden';
}

/** Hears the page shown or hidden, with whether it shows now. Returns what stops it. */
export function onPageVisibilityChange(listener: (visible: boolean) => void): () => void {
  const heard = () => listener(isPageVisible());
  document.addEventListener('visibilitychange', heard);
  return () => document.removeEventListener('visibilitychange', heard);
}
