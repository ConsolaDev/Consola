import { isShellShortcut } from '../../utils/shellShortcut';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { RotateCw, X } from 'lucide-react';
import { useShellStore } from '../../stores/shellStore';
import { SHELL_SHORTCUT_LABEL } from '../../utils/shellShortcut';
import type { ShellData } from '../../../shared/shell';
import { TERMINAL_SCROLLBACK_LINES } from '../../../shared/constants';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildXtermTheme, readTerminalFont, TERMINAL_FONT_FAMILY } from './xtermTheme';
import { openTerminalLink } from './terminalLinks';
import { terminalKeyOverride } from './terminalKeys';
import { restoreScreen, whenSettled } from './restoreScreen';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

export function ShellPanel({ instanceId }: { instanceId: string }) {
  const toggleShell = useShellStore(state => state.toggle);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [generation, setGeneration] = useState(0);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState('');
  const [cwd, setCwd] = useState('');
  const theme = useSettingsStore(state => state.resolvedTheme);
  const fontSize = useSettingsStore(state => state.terminalFontSize);

  useEffect(() => {
    if (!containerRef.current) return;
    const api = window.shellAPI;
    const settings = useSettingsStore.getState();
    const font = readTerminalFont(settings.terminalFontSize);
    const terminal = new Terminal({
      ...font, theme: buildXtermTheme(settings.resolvedTheme === 'dark'),
      cursorBlink: true, scrollback: TERMINAL_SCROLLBACK_LINES, macOptionIsMeta: true,
      allowProposedApi: true, linkHandler: { activate: openTerminalLink },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    terminal.loadAddon(new WebLinksAddon(openTerminalLink));
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fit.fit();
    let disposed = false;
    let ready = false;
    // Until the screen main kept is in this view, the view stays the size
    // that screen was captured at; after that it follows its pane once the
    // pane's size has settled. See restoreScreen and whenSettled for why.
    let restored = false;
    let exitReceived = false;
    let pending: ShellData[] = [];
    setExited(false);
    setError('');
    const settled = whenSettled(() => {
      if (disposed || !restored || !containerRef.current?.clientHeight) return;
      fit.fit();
      api.resize(instanceId, terminal.cols, terminal.rows);
    });
    fitRef.current = settled.request;
    const input = terminal.onData(data => { if (ready) api.input(instanceId, data); });
    terminal.attachCustomKeyEventHandler(event => {
      if (isShellShortcut(event)) {
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
    const offData = api.onData(message => {
      if (message.instanceId !== instanceId) return;
      if (ready) terminal.write(message.data);
      else pending.push(message);
    });
    const offExit = api.onExit(message => {
      if (message.instanceId !== instanceId) return;
      exitReceived = true;
      setExited(true);
    });
    const attach = generation > 0 ? api.restart : api.attach;
    void attach({ instanceId, cols: terminal.cols, rows: terminal.rows }).then(snapshot => {
      if (disposed) return;
      restoreScreen(terminal, snapshot, () => {
        restored = true;
        settled.request();
      });
      // Events can arrive before the IPC reply. Replay already contains every
      // event up to its sequence; append only the newer bytes, exactly once.
      pending.filter(message => message.sequence > snapshot.sequence).forEach(message => terminal.write(message.data));
      pending = [];
      ready = true;
      setCwd(snapshot.cwd);
      setExited(snapshot.exited || exitReceived);
      terminal.focus();
    }).catch(reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const observer = new ResizeObserver(() => settled.request());
    observer.observe(containerRef.current);
    void document.fonts.load(`${font.fontWeight} ${font.fontSize}px "${TERMINAL_FONT_FAMILY}"`).then(() => {
      if (!disposed) { terminal.clearTextureAtlas(); settled.request(); }
    }).catch(() => {});
    return () => {
      disposed = true;
      settled.cancel();
      observer.disconnect();
      offData();
      offExit();
      input.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [instanceId, generation]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = buildXtermTheme(theme === 'dark');
  }, [theme]);
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = readTerminalFont(fontSize).fontSize;
      fitRef.current?.();
    }
  }, [fontSize]);

  return <div className="terminal-panel shell-panel" data-testid="session-shell">
    <div className="shell-details">
      <span className="shell-directory" title={cwd}>Started in: {cwd || 'Starting shell…'}</span>
      {(exited || error) && <button type="button" className="terminal-restart-button" onClick={() => setGeneration(value => value + 1)}>
        <RotateCw size={13} /> {error ? 'Retry' : 'New shell'}
      </button>}
      {exited && <span>Shell exited</span>}
      <button
        type="button"
        className="shell-collapse-button"
        aria-label="Collapse terminal"
        title={`Collapse terminal (${SHELL_SHORTCUT_LABEL})`}
        onClick={() => toggleShell(instanceId)}
      >
        <X size={14} />
      </button>
    </div>
    {error && <div className="shell-error" role="alert">Could not start shell: {error}</div>}
    <div className="terminal-surface-frame">
      <div className="terminal-surface" ref={containerRef} onClick={() => terminalRef.current?.focus()} />
    </div>
  </div>;
}
