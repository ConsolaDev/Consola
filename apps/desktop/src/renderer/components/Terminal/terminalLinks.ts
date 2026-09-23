/**
 * Open a link clicked in the terminal in the OS browser.
 *
 * xterm's own activation — the web-links addon's and the OSC 8 one in core —
 * calls `window.open()` with no URL and assigns `location.href` on the window
 * it gets back. That never works here: main's window-open handler denies every
 * popup and forwards only the URL it was handed, and a blank one is no URL at
 * all. So `window.open()` returns null, the addon logs "Opening link blocked"
 * and nothing happens. Passing the URL is what lets the handler send it on to
 * `shell.openExternal`, the same path the app's `target="_blank"` anchors take.
 *
 * Shared by both link kinds: the addon calls with `(event, uri)`, xterm's
 * `ILinkHandler.activate` adds a buffer range this ignores.
 */
export function openTerminalLink(_event: MouseEvent, uri: string): void {
    window.open(uri, '_blank');
}
