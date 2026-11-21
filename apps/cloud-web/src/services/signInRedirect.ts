/**
 * The `?error=` code Google's sign-in came back with, read once. It removes `error` and
 * `error_description` from the address, so a reload does not show the failure again.
 */
export function takeSignInErrorCode(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('error');
  if (code === null) return null;
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return code;
}
