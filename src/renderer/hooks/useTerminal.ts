import { useEffect, useCallback } from 'react';
import { terminalBridge } from '../services/terminalBridge';
import { useTerminalStore } from '../stores/terminalStore';
import type { TerminalMode } from '../types/terminal';

/**
 * Hook for terminal operations in React components.
 * Handles subscriptions with proper cleanup.
 */
export function useTerminal() {
  const { setMode, setConnected } = useTerminalStore();

  // Subscribe to mode changes from main process
  useEffect(() => {
    const handleModeChange = (mode: TerminalMode) => {
      setMode(mode);
    };

    terminalBridge.onModeChanged(handleModeChange);
    setConnected(terminalBridge.isAvailable());

    return () => {
      terminalBridge.removeModeChangedListener(handleModeChange);
    };
  }, [setMode, setConnected]);

  // Memoized actions
  const sendInput = useCallback((data: string) => {
    terminalBridge.sendInput(data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    terminalBridge.resize(cols, rows);
  }, []);

  return {
    sendInput,
    resize,
    onData: terminalBridge.onData,
    removeDataListener: terminalBridge.removeDataListener,
    isAvailable: terminalBridge.isAvailable(),
  };
}
