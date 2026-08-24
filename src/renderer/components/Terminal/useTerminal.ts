import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { HarnessLaunchFields } from '../../../shared/types';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { terminalBridge } from '../../services/terminalBridge';
import { buildXtermTheme, readTerminalFont, TERMINAL_FONT_FAMILY } from './xtermTheme';
import { openTerminalLink } from './terminalLinks';

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
 * switch) tears down only the view, and remounting repaints from the buffered
 * output the main process kept. Closing a session is what destroys the PTY.
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
    const fitAddonRef = useRef<FitAddon | null>(null);

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
            // Claude repaints its own view; the PTY is the source of truth.
            scrollback: 5000,
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
        fitAddonRef.current = fitAddon;

        fitAddon.fit();

        let disposed = false;

        // Forward keystrokes to the PTY.
        const dataDisposable = terminal.onData((data) => {
            terminalBridge.sendInput(instanceId, data);
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
                refit(terminal, fitAddon, instanceId);
            })
            .catch(() => {
                // Fallback metrics are still usable; nothing to recover here.
            });

        // A prompt typed on the new-session screen travels with the create call;
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
                // Repaint whatever the PTY produced while this view was gone.
                if (snapshot.replay) {
                    terminal.write(snapshot.replay);
                }
                setTerminalState(instanceId, { hasExited: snapshot.exited });
                terminal.focus();
            })
            .catch((error) => {
                console.error('Failed to start terminal:', error);
                terminal.write(
                    "\r\n\x1b[31mFailed to start this session's CLI. Check the harness in Settings — is the binary installed and on your PATH?\x1b[0m\r\n"
                );
            });

        // Keep the PTY's dimensions in step with the pane.
        const resizeObserver = new ResizeObserver(() => {
            if (disposed) return;
            refit(terminal, fitAddon, instanceId);
        });
        resizeObserver.observe(container);

        return () => {
            disposed = true;
            resizeObserver.disconnect();
            unsubscribeData();
            dataDisposable.dispose();
            terminal.dispose();
            terminalRef.current = null;
            fitAddonRef.current = null;
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
        const fitAddon = fitAddonRef.current;
        if (!terminal || !fitAddon) return;

        const font = readTerminalFont(terminalFontSize);
        if (terminal.options.fontSize === font.fontSize) return;

        terminal.options.fontSize = font.fontSize;
        refit(terminal, fitAddon, instanceId);
    }, [terminalFontSize, instanceId]);

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
