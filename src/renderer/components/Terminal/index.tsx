import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminal } from '../../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

export default function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { setDimensions, mode } = useTerminalStore();
  const { sendInput, resize, onData, removeDataListener } = useTerminal();

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      fitAddonRef.current.fit();
      const dims = fitAddonRef.current.proposeDimensions();
      if (dims) {
        setDimensions(dims.cols, dims.rows);
        resize(dims.cols, dims.rows);
      }
    }
  }, [setDimensions, resize]);

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    // Create terminal instance
    const terminal = new XTerm({
      theme: {
        background: '#0a0a0a',
        foreground: '#fafafa',
        cursor: '#fafafa',
        cursorAccent: '#0a0a0a',
        selectionBackground: '#364559',
        black: '#0a0a0a',
        red: '#ff6b6b',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#fafafa',
        brightBlack: '#6b7280',
        brightRed: '#ff8a8a',
        brightGreen: '#6ee7a0',
        brightYellow: '#fcd34d',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      fontSize: 14,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
    });

    // Load addons
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    // Mount terminal
    terminal.open(containerRef.current);
    fitAddon.fit();

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle terminal input - uses hook's sendInput
    terminal.onData((data) => {
      sendInput(data);
    });

    // Handle PTY output - uses hook's onData
    const handleData = (data: string) => {
      terminal.write(data);
    };
    onData(handleData);

    // Initial resize
    setTimeout(handleResize, 100);

    // Resize observer for container
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    // Window resize handler
    window.addEventListener('resize', handleResize);

    // Focus terminal
    terminal.focus();

    // Log successful mount for debugging
    console.log('[Terminal] Successfully mounted and connected');

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      removeDataListener(handleData);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [handleResize, sendInput, onData, removeDataListener]);

  // Clear terminal on mode change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.clear();
      terminalRef.current.focus();
    }
  }, [mode]);

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      data-testid="terminal-container"
    />
  );
}
