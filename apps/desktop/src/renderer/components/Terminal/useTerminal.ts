import { isShellShortcut } from '../../utils/shellShortcut';
import { isBrowserShortcut, matchWorkspaceShortcut } from '../../utils/platform';
import { isInfoPanelShortcut } from '../../utils/infoPanelShortcut';
import { isOpenInShortcut } from '../../utils/openInShortcut';
import { isSidePanelShortcut } from '../../utils/sidePanelShortcut';
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
import { terminalLinkHandler } from './terminalLinks';
import { terminalKeyOverride } from './terminalKeys';
import { restoreScreen, whenSettled } from './restoreScreen';
import { attachTuiWheel } from './tuiWheel';

interface UseTerminalOptions {
  instanceId: string;
  /** The session record this terminal belongs to; a clicked link opens in its browser. */
  sessionId: string;
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
  sessionId,
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
      linkHandler: { activate: terminalLinkHandler(sessionId) },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon(terminalLinkHandler(sessionId)));

    const unicodeAddon = new Unicode11Addon();
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = '11';

    terminal.open(container);

    let disposed = false;
    // Until the screen main kept is in this view, the view stays the size
    // that screen was captured at; after that it follows its pane once the
    // pane's size has settled. See restoreScreen and whenSettled for why.
    let restored = false;
    const settled = whenSettled(() => {
      if (!disposed && restored) refit(terminal, fitAddon, instanceId);
    });
    fitRef.current = settled.request;

    // WebGL rendering is a big win for a repainting TUI, but it fails on
    // some GPUs — fall back to the DOM renderer rather than a blank pane.
    // A lost GL context is not the same as one that never worked: it can
    // happen mid-session on a GPU switch or driver reset. Disposing the
    // addon is what hands rendering back to the DOM renderer; without
    // this the pane simply stops painting. A pane left on the DOM renderer
    // for good repaints a busy TUI far slower, so WebGL is tried again
    // shortly, unless the context keeps going (WEBGL_RETRY_LIMIT a minute).
    let webglRetry: ReturnType<typeof setTimeout> | undefined;
    const webglLosses: number[] = [];
    const attachWebgl = () => {
      if (disposed) return;
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('WebGL context lost, falling back to DOM renderer');
          webglAddon.dispose();
          // The DOM renderer measures cells a little wider: fit the grid again.
          settled.request();
          const now = Date.now();
          webglLosses.push(now);
          while (webglLosses.length && now - webglLosses[0] > WEBGL_RETRY_WINDOW_MS) {
            webglLosses.shift();
          }
          if (webglLosses.length < WEBGL_RETRY_LIMIT) {
            clearTimeout(webglRetry);
            webglRetry = setTimeout(attachWebgl, WEBGL_RETRY_DELAY_MS);
          }
        });
        terminal.loadAddon(webglAddon);
        settled.request();
      } catch (error) {
        console.warn('WebGL renderer unavailable, using DOM renderer:', error);
      }
    };
    attachWebgl();

    terminalRef.current = terminal;

    fitAddon.fit();

    // Forward keystrokes to the PTY. The wheel reports one gesture is worth
    // travel as one write, so the CLI can paint them as one frame.
    let wheelBatch: string[] | null = null;
    const dataDisposable = terminal.onData((data) => {
      if (wheelBatch) wheelBatch.push(data);
      else terminalBridge.sendInput(instanceId, data);
    });
    attachTuiWheel(terminal, (replay) => {
      wheelBatch = [];
      try {
        replay();
      } finally {
        const batch = wheelBatch.join('');
        wheelBatch = null;
        if (batch) terminalBridge.sendInput(instanceId, batch);
      }
    });

    // A few keys have to send something other than what xterm would.
    // Claiming one means answering for its whole press — keydown, keypress
    // and keyup — so xterm never emits its own bytes alongside ours. The
    // substitute goes through `input()` rather than the bridge, so it takes
    // the same path to the PTY as a typed key, scrollback included.
    terminal.attachCustomKeyEventHandler((event) => {
      // Application chords must reach the global listener without
      // sending numeric control sequences into the terminal.
      if (
        isShellShortcut(event) ||
        isBrowserShortcut(event) ||
        isSidePanelShortcut(event) ||
        isInfoPanelShortcut(event) ||
        isOpenInShortcut(event) ||
        matchWorkspaceShortcut(event) !== null
      ) {
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

    // Receive this session's output only, and only once main's screen is in.
    // Main sends nothing until this view attaches, and what was gathered
    // before then is in that screen already: written as well, it would be
    // painted twice. Anything that arrives first is from an earlier view.
    let attached = false;
    const unsubscribeData = terminalBridge.onData((message) => {
      if (attached && message.instanceId === instanceId) {
        terminal.write(message.data);
      }
    });

    // xterm measures the character cell the moment it opens. If the bundled
    // font has not finished loading by then it measures a fallback, and every
    // glyph afterwards is drawn on a grid sized for the wrong font. Re-measure
    // once the real font is in. Normally it already is (main.tsx starts the
    // load at app startup), and then nothing is redrawn: the glyph atlas is
    // shared, and clearing it re-rasterises every glyph for every pane.
    const fontSpec = `${font.fontWeight} ${font.fontSize}px "${TERMINAL_FONT_FAMILY}"`;
    if (!document.fonts.check(fontSpec)) {
      document.fonts
        .load(fontSpec)
        .then(() => {
          if (disposed) return;
          terminal.clearTextureAtlas();
          settled.request();
        })
        .catch(() => {
          // Fallback metrics are still usable; nothing to recover here.
        });
    }

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
        // then follow the pane. Live output from here on lands after it.
        attached = true;
        restoreScreen(terminal, snapshot, () => {
          restored = true;
          settled.request();
        });
        setTerminalState(instanceId, { hasExited: snapshot.exited });
        terminal.focus();
      })
      .catch((error: unknown) => {
        console.error('Failed to start terminal:', error);
        attached = true;
        terminal.write(
          "\r\n\x1b[31mFailed to start this session's CLI. Check the harness in Settings — is the binary installed and on your PATH?\x1b[0m\r\n",
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
      clearTimeout(webglRetry);
      resizeObserver.disconnect();
      unsubscribeData();
      terminalBridge.detach(instanceId);
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // The PTY identity is what matters here; theme and font are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, sessionId, workspaceId, cwd, claudeSessionId, resume, setTerminalState]);

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

/** WebGL is tried again this long after its context is lost… */
const WEBGL_RETRY_DELAY_MS = 2000;
/** …unless it was lost this many times within the window. */
const WEBGL_RETRY_LIMIT = 3;
const WEBGL_RETRY_WINDOW_MS = 60_000;

/**
 * Re-measure the pane and push new dimensions to the PTY.
 *
 * Only when they changed: the view already matches the PTY once its
 * snapshot is in (restoreScreen), and a resize the CLI did not need still
 * resizes main's screen and reads as input.
 */
function refit(terminal: Terminal, fitAddon: FitAddon, instanceId: string) {
  try {
    const { cols, rows } = terminal;
    fitAddon.fit();
    if (terminal.cols === cols && terminal.rows === rows) return;
    terminalBridge.resize(instanceId, terminal.cols, terminal.rows);
  } catch {
    // Pane is hidden or zero-sized; the next observation will fit.
  }
}
