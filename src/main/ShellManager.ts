import * as pty from 'node-pty';
import type { WebContents } from 'electron';
import { getLoginEnv } from './LoginEnvironment';
import { ScreenModel } from './ScreenModel';
import { IPC_CHANNELS } from '../shared/constants';
import type { ShellOptions, ShellSnapshot } from '../shared/shell';

interface Shell {
  process: pty.IPty | null;
  screen: ScreenModel;
  cwd: string;
  sequence: number;
  owner: WebContents;
  subscriptions: { dispose(): void }[];
}

/** Ordinary shells belong to sessions, independently of their agent PTYs. */
export class ShellManager {
  private shells = new Map<string, Shell>();

  async attach(options: ShellOptions, cwd: string, owner: WebContents): Promise<ShellSnapshot> {
    const { instanceId, cols, rows } = options;
    this.validateSize(cols, rows);
    let shell = this.shells.get(instanceId);
    if (!shell) {
      const env: NodeJS.ProcessEnv = { ...getLoginEnv(), TERM: 'xterm-256color' };
      const binary = process.platform === 'win32'
        ? env.COMSPEC || 'powershell.exe'
        : env.SHELL || '/bin/bash';
      const child = pty.spawn(binary, process.platform === 'win32' ? [] : ['-il'], {
        name: 'xterm-256color', cwd, cols, rows, env,
      });
      shell = { process: child, screen: new ScreenModel(cols, rows), cwd, sequence: 0, owner, subscriptions: [] };
      this.shells.set(instanceId, shell);
      const current = shell;
      current.subscriptions.push(child.onData(data => {
        // Send only after the mirror consumed these bytes. Snapshot and stream
        // sequence numbers then describe precisely the same output boundary.
        current.screen.write(data, () => {
          if (this.shells.get(instanceId) !== current) return;
          current.sequence++;
          this.send(current, IPC_CHANNELS.SHELL_DATA, { instanceId, data, sequence: current.sequence });
        });
      }));
      current.subscriptions.push(child.onExit(({ exitCode }) => {
        current.process = null;
        this.send(current, IPC_CHANNELS.SHELL_EXIT, { instanceId, exitCode });
      }));
    }
    shell.owner = owner;
    const current = shell;
    return new Promise(resolve => {
      current.screen.write('', () => resolve({
        replay: current.screen.snapshot(), sequence: current.sequence,
        exited: current.process === null, cwd: current.cwd,
      }));
    });
  }

  input(instanceId: string, data: string, owner: WebContents): void {
    const shell = this.shells.get(instanceId);
    if (shell?.owner === owner && typeof data === 'string') shell.process?.write(data);
  }

  resize(instanceId: string, cols: number, rows: number, owner: WebContents): void {
    const shell = this.shells.get(instanceId);
    if (!shell || shell.owner !== owner) return;
    if (!this.validSize(cols, rows)) return;
    shell.process?.resize(cols, rows);
    shell.screen.resize(cols, rows);
  }

  /** Restart is only offered after exit, so it never kills a running command. */
  restart(options: ShellOptions, cwd: string, owner: WebContents): Promise<ShellSnapshot> {
    const shell = this.shells.get(options.instanceId);
    if (shell && !shell.process) this.destroy(options.instanceId);
    return this.attach(options, cwd, owner);
  }

  destroy(instanceId: string): void {
    const shell = this.shells.get(instanceId);
    if (!shell) return;
    this.shells.delete(instanceId);
    shell.subscriptions.forEach(subscription => subscription.dispose());
    shell.process?.kill();
    shell.screen.dispose();
  }

  destroyAll(): void {
    for (const id of this.shells.keys()) this.destroy(id);
  }

  private send(shell: Shell, channel: string, payload: unknown): void {
    if (!shell.owner.isDestroyed()) shell.owner.send(channel, payload);
  }

  private validSize(cols: number, rows: number): boolean {
    return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000;
  }

  private validateSize(cols: number, rows: number): void {
    if (!this.validSize(cols, rows)) throw new Error('Invalid terminal dimensions.');
  }
}
