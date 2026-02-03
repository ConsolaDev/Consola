import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as os from 'os';
import { TerminalMode, TerminalDimensions } from '../shared/types';
import { DEFAULT_DIMENSIONS } from '../shared/constants';

export interface TerminalServiceEvents {
    'data': (data: string) => void;
    'mode-changed': (mode: TerminalMode) => void;
    'exit': () => void;
}

export class TerminalService extends EventEmitter {
    private shellPty: pty.IPty | null = null;
    private claudePty: pty.IPty | null = null;
    private currentMode: TerminalMode = TerminalMode.SHELL;
    private dimensions: TerminalDimensions;
    private workingDirectory: string;

    constructor(cwd?: string) {
        super();
        this.dimensions = { ...DEFAULT_DIMENSIONS };
        this.workingDirectory = cwd || process.cwd();
    }

    public start(): void {
        this.initShell();
    }

    public getCurrentMode(): TerminalMode {
        return this.currentMode;
    }

    public write(data: string): void {
        const activePty = this.getActivePty();
        if (activePty) {
            activePty.write(data);
        }
    }

    public resize(cols: number, rows: number): void {
        this.dimensions = { cols, rows };
        if (this.shellPty) {
            this.shellPty.resize(cols, rows);
        }
        if (this.claudePty) {
            this.claudePty.resize(cols, rows);
        }
    }

    public switchMode(mode: TerminalMode): void {
        if (this.currentMode === mode) return;

        this.currentMode = mode;

        if (mode === TerminalMode.CLAUDE && !this.claudePty) {
            this.initClaude();
        }

        this.emit('mode-changed', mode);

        // Trigger redraw by resizing the active PTY
        const activePty = this.getActivePty();
        if (activePty) {
            activePty.resize(this.dimensions.cols, this.dimensions.rows);
        }
    }

    public destroy(): void {
        if (this.shellPty) {
            this.shellPty.kill();
            this.shellPty = null;
        }
        if (this.claudePty) {
            this.claudePty.kill();
            this.claudePty = null;
        }
    }

    private initShell(): void {
        const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

        try {
            this.shellPty = pty.spawn(shell, [], {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.workingDirectory,
                env: process.env as { [key: string]: string }
            });

            this.shellPty.onData((data) => {
                if (this.currentMode === TerminalMode.SHELL) {
                    this.emit('data', data);
                }
            });

            this.shellPty.onExit(() => {
                this.emit('exit');
            });
        } catch (error) {
            console.error('Error spawning shell:', error);
            throw error;
        }
    }

    private initClaude(): void {
        if (this.claudePty) return;

        try {
            this.claudePty = pty.spawn('claude', [], {
                name: 'xterm-256color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows,
                cwd: this.workingDirectory,
                env: process.env as { [key: string]: string }
            });

            this.claudePty.onData((data) => {
                if (this.currentMode === TerminalMode.CLAUDE) {
                    this.emit('data', data);
                }
            });

            this.claudePty.onExit(() => {
                this.claudePty = null;
                // Switch back to shell when Claude exits
                this.switchMode(TerminalMode.SHELL);
            });
        } catch (error) {
            console.error('Error spawning Claude:', error);
            // Switch back to shell if Claude fails to spawn
            this.switchMode(TerminalMode.SHELL);
        }
    }

    private getActivePty(): pty.IPty | null {
        return this.currentMode === TerminalMode.SHELL ? this.shellPty : this.claudePty;
    }
}
