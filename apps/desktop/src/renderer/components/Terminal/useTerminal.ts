import { isShellShortcut } from '../../utils/shellShortcut';
import { matchWorkspaceShortcut } from '../../utils/platform';
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { HarnessLaunchFields } from '../../../shared/types';
import { TERMINAL_SCROLLBACK_LINES } from '../../../shared/constants';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { terminalBridge } from '../../services/terminalBridge';
import { buildXtermTheme, readTerminalFont, TERMINAL_FONT_FAMILY } from './xtermTheme';
import { openTerminalLink } from './terminalLinks';
import { terminalKeyOverride } from './terminalKeys';
import { restoreScreen, whenSettled } from './restoreScreen';

interface UseTerminalOptions {
    instanceId: string;
    /** Workspace this session belongs to; main resolves its GitHub binding. */
    workspaceId: string;
    cwd: string;
    claudeSessionId: string;
    /** Whether this tab has run before and should resume its conversation. */
    resume: boolean;
    /** Binary, config directory and arguments from this session's harness. */
    harness: HarnessLaunchFields;
    /** Model this session was pinned to, replayed on every launch. */
    model?: string;
}

/**
 * Attach an xterm view to a session's PTY.
 *
 * The PTY belongs to the main process and outlives this hook: unmounting (a tab
 * switch) tears down only the view, and remounting repaints from the screen
 * the main process kept (`restoreScreen`). Closing a session is what destroys
 * the PTY.
 */
export function useTerminal({
    instanceId,
    workspaceId,
    cwd,
    claudeSessionId,
    resume,
    harness,
    model,
}: UseTerminalOptions) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    /** Asks the view to follow its pane; null while unmounted. */
    const fitRef = useRef<(() => void) | null>(null);

    const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
    const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
    const setTerminalState = useTerminalStore((state) => state.setState);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Read once at creation; a later change is applied by the effect below
        // rather than by rebuilding the view and re-attaching to the PTY.
        const font = readTerminalFont(useSettingsStore.getState().terminalFontSize);
        const terminal = new Terminal({
            ...font,
            theme: buildXtermTheme(resolvedTheme === 'dark'),
            cursorBlink: true,
            allowProposedApi: true,
            // Matches main's ScreenModel, which repaints this pane on remount.
            scrollback: TERMINAL_SCROLLBACK_LINES,
            macOptionIsMeta: true,
            // OSC 8 hyperlinks; plain URLs in the output are the addon's below.
            linkHandler: { activate: openTerminalLink },
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon(openTerminalLink));

        const unicodeAddon = new Unicode11Addon();
        terminal.loadAddon(unicodeAddon);
        terminal.unicode.activeVersion = '11';

        terminal.open(container);

        // WebGL rendering is a big win for a repainting TUI, but it fails on
        // some GPUs — fall back to the DOM renderer rather than a blank pane.
        try {
            const webglAddon = new WebglAddon();
            // A lost GL context is not the same as one that never worked: it can
            // happen mid-session on a GPU switch or driver reset. Disposing the
            // addon is what hands rendering back to the DOM renderer; without
            // this the pane simply stops painting.
            webglAddon.onContextLoss(() => {
                console.warn('WebGL context lost, falling back to DOM renderer');
                webglAddon.dispose();
            });
            terminal.loadAddon(webglAddon);
        } catch (error) {
            console.warn('WebGL renderer unavailable, using DOM renderer:', error);
        }

        terminalRef.current = terminal;

        fitAddon.fit();

        let disposed = false;
        // Until the screen main kept is in this view, the view stays the size
        // that screen was captured at; after that it follows its pane once the
        // pane's size has settled. See restoreScreen and whenSettled for why.
        let restored = false;
        const settled = whenSettled(() => {
            if (!disposed && restored) refit(terminal, fitAddon, instanceId);
        });
        fitRef.current = settled.request;

        // Forward keystrokes to the PTY.
        const dataDisposable = terminal.onData((data) => {
            terminalBridge.sendInput(instanceId, data);
        });

        // A few keys have to send something other than what xterm would.
        // Claiming one means answering for its whole press — keydown, keypress
        // and keyup — so xterm never emits its own bytes alongside ours. The
        // substitute goes through `input()` rather than the bridge, so it takes
        // the same path to the PTY as a typed key, scrollback included.
        terminal.attachCustomKeyEventHandler((event) => {
            // Application chords must reach the global listener without
            // sending numeric control sequences into the terminal.
            if (isShellShortcut(event) || matchWorkspaceShortcut(event) !== null) {
                event.preventDefault();
                return false;
            }
            const override = terminalKeyOverride(event);
            if (!override) return true;

            if (event.type === 'keydown') {
                event.preventDefault();
                terminal.input(override);
            }
            return false;
        });

        // Receive this session's output only.
        const unsubscribeData = terminalBridge.onData((message) => {
            if (message.instanceId === instanceId) {
                terminal.write(message.data);
            }
        });

        // xterm measures the character cell the moment it opens. If the bundled
        // font has not finished loading by then it measures a fallback, and every
        // glyph afterwards is drawn on a grid sized for the wrong font. Re-measure
        // once the real font is in — normally a no-op, since main.tsx starts the
        // load at app startup.
        document.fonts
            .load(`${font.fontWeight} ${font.fontSize}px "${TERMINAL_FONT_FAMILY}"`)
            .then(() => {
                if (disposed) return;
                terminal.clearTextureAtlas();
                settled.request();
            })
            .catch(() => {
                // Fallback metrics are still usable; nothing to recover here.
            });

        // A pending prompt from a launch action travels with the create call;
        // the main process submits it once the CLI is ready and is not sitting
        // on a confirmation menu.
        const initialPrompt = useTerminalStore.getState().consumePendingPrompt(instanceId);

        terminalBridge
            .create({
                instanceId,
                workspaceId,
                cwd,
                claudeSessionId,
                resume,
                cols: terminal.cols,
                rows: terminal.rows,
                initialPrompt,
                model,
                // Read at creation time on purpose: the PTY is already running
                // for an existing session, and a harness edit only applies to
                // the next launch.
                ...harness,
            })
            .then((snapshot) => {
                if (disposed) return;
                // Repaint whatever the PTY produced while this view was gone,
                // then follow the pane.
                restoreScreen(terminal, snapshot, () => {
                    restored = true;
                    settled.request();
                });
                setTerminalState(instanceId, { hasExited: snapshot.exited });
                terminal.focus();
            })
            .catch((error) => {
                console.error('Failed to start terminal:', error);
                terminal.write(
                    "\r\n\x1b[31mFailed to start this session's CLI. Check the harness in Settings — is the binary installed and on your PATH?\x1b[0m\r\n"
                );
                restored = true;
                settled.request();
            });

        // Keep the PTY's dimensions in step with the pane.
        const resizeObserver = new ResizeObserver(() => settled.request());
        resizeObserver.observe(container);

        return () => {
            disposed = true;
            settled.cancel();
            resizeObserver.disconnect();
            unsubscribeData();
            dataDisposable.dispose();
            terminal.dispose();
            terminalRef.current = null;
            fitRef.current = null;
        };
        // The PTY identity is what matters here; theme and font are applied below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instanceId, workspaceId, cwd, claudeSessionId, resume, setTerminalState]);

    // Follow the app's light/dark setting without rebuilding the terminal.
    useEffect(() => {
        if (!terminalRef.current) return;
        terminalRef.current.options.theme = buildXtermTheme(resolvedTheme === 'dark');
    }, [resolvedTheme]);

    // A size change resizes the character cell, so the pane holds a different
    // number of rows and columns — the PTY has to be told.
    useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;

        const font = readTerminalFont(terminalFontSize);
        if (terminal.options.fontSize === font.fontSize) return;

        terminal.options.fontSize = font.fontSize;
        fitRef.current?.();
    }, [terminalFontSize]);

    const focus = () => terminalRef.current?.focus();

    return { containerRef, focus };
}

/** Re-measure the pane and push the new dimensions to the PTY. */
function refit(terminal: Terminal, fitAddon: FitAddon, instanceId: string) {
    try {
        fitAddon.fit();
        terminalBridge.resize(instanceId, terminal.cols, terminal.rows);
    } catch {
        // Pane is hidden or zero-sized; the next observation will fit.
    }
}
