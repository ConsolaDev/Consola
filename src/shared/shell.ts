export interface ShellOptions {
  instanceId: string;
  cols: number;
  rows: number;
}

export interface ShellSnapshot {
  replay: string;
  sequence: number;
  exited: boolean;
  cwd: string;
}

export interface ShellData {
  instanceId: string;
  data: string;
  sequence: number;
}

export interface ShellAPI {
  attach(options: ShellOptions): Promise<ShellSnapshot>;
  restart(options: ShellOptions): Promise<ShellSnapshot>;
  input(instanceId: string, data: string): void;
  resize(instanceId: string, cols: number, rows: number): void;
  onData(callback: (message: ShellData) => void): () => void;
  onExit(callback: (message: { instanceId: string; exitCode: number }) => void): () => void;
}
