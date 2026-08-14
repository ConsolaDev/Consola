import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { terminalBridge } from '../../services/terminalBridge';
import { buildXtermTheme, readTerminalFont } from './xtermTheme';

interface UseTerminalOptions {
    instanceId: string;
    cwd: string;
    claudeSessionId: string;
    /** Whether this tab has run before and should resume its conversation. */
    resume: boolean;
}

/**
 * Attach an xterm view to a session's PTY.
 *
 * The PTY belongs to the main process and outlives this hook: unmounting (a tab
 * switch) tears down only the view, and remounting repaints from the buffered
 * output the main process kept. Closing a session is what destroys the PTY.
 */
export function useTerminal({ instanceId, cwd, claudeSessionId, resume }: UseTerminalOptions) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
    const setTerminalState = useTerminalStore((state) => state.setState);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const { fontFamily, fontSize } = readTerminalFont();
        const terminal = new Terminal({
            fontFamily,
            fontSize,
            theme: buildXtermTheme(resolvedTheme === 'dark'),
            cursorBlink: true,
            allowProposedApi: true,
            // Claude repaints its own view; the PTY is the source of truth.
            scrollback: 5000,
            macOptionIsMeta: true,
        });

        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());

        const unicodeAddon = new Unicode11Addon();
        terminal.loadAddon(unicodeAddon);
        terminal.unicode.activeVersion = '11';

        terminal.open(container);

        // WebGL rendering is a big win for a repainting TUI, but it fails on
        // some GPUs — fall back to the DOM renderer rather than a blank pane.
        try {
            terminal.loadAddon(new WebglAddon());
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

        // A prompt typed on the new-session screen travels with the create call;
        // the main process submits it once the CLI is ready and is not sitting
        // on a confirmation menu.
        const initialPrompt = useTerminalStore.getState().consumePendingPrompt(instanceId);

        terminalBridge
            .create({
                instanceId,
                cwd,
                claudeSessionId,
                resume,
                cols: terminal.cols,
                rows: terminal.rows,
                initialPrompt,
            })
            .then((snapshot) => {
                if (disposed) return;
                // Repaint whatever the PTY produced while this view was gone.
                if (snapshot.replay) {
                    terminal.write(snapshot.replay);
                }
                setTerminalState(instanceId, {
                    mode: snapshot.mode,
                    hasExited: snapshot.exited,
                });
                terminal.focus();
            })
            .catch((error) => {
                console.error('Failed to start terminal:', error);
                terminal.write('\r\n\x1b[31mFailed to start claude. Is it installed and on your PATH?\x1b[0m\r\n');
            });

        // Keep the PTY's dimensions in step with the pane.
        const resizeObserver = new ResizeObserver(() => {
            if (disposed) return;
            try {
                fitAddon.fit();
                terminalBridge.resize(instanceId, terminal.cols, terminal.rows);
            } catch {
                // Pane is hidden or zero-sized; the next observation will fit.
            }
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
        // The PTY identity is what matters here; theme changes are applied below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [instanceId, cwd, claudeSessionId, resume, setTerminalState]);

    // Follow the app's light/dark setting without rebuilding the terminal.
    useEffect(() => {
        if (!terminalRef.current) return;
        terminalRef.current.options.theme = buildXtermTheme(resolvedTheme === 'dark');
    }, [resolvedTheme]);

    const focus = () => terminalRef.current?.focus();

    return { containerRef, focus };
}
