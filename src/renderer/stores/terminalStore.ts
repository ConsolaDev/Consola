import { create } from 'zustand';
import { terminalBridge } from '../services/terminalBridge';
import type { TerminalMode } from '../types/terminal';

interface TerminalState {
  // State
  mode: TerminalMode;
  isConnected: boolean;
  dimensions: { cols: number; rows: number };

  // Actions
  setMode: (mode: TerminalMode) => void;
  setConnected: (connected: boolean) => void;
  setDimensions: (cols: number, rows: number) => void;
  switchMode: (mode: TerminalMode) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  // Initial state
  mode: 'SHELL',
  isConnected: false,
  dimensions: { cols: 80, rows: 24 },

  // Actions
  setMode: (mode) => set({ mode }),
  setConnected: (connected) => set({ isConnected: connected }),
  setDimensions: (cols, rows) => set({ dimensions: { cols, rows } }),

  switchMode: (mode) => {
    if (get().mode === mode) return;
    set({ mode });
    terminalBridge.switchMode(mode);
  },
}));
