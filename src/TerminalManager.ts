import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import * as os from 'os';
import * as process from 'process';
import chalk from 'chalk';

export enum TerminalMode {
    SHELL = 'SHELL',
    CLAUDE = 'CLAUDE'
}

export class TerminalManager extends EventEmitter {
    private shellPty: pty.IPty | null = null;
    private claudePty: pty.IPty | null = null;
    private currentMode: TerminalMode = TerminalMode.SHELL;
    private isClaudeRunning: boolean = false;
    private dimensions: { cols: number; rows: number };

    constructor() {
        super();
        this.dimensions = {
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows || 24
        };
        
        // Handle window resize
        process.stdout.on('resize', () => {
             this.resize({
                cols: process.stdout.columns || 80,
                rows: process.stdout.rows || 24
            });
        });
    }

    public start() {
        this.initShell();
        this.renderStatus();
        
        // Setup raw mode for stdin
        if (process.stdin.setRawMode) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        
        process.stdin.on('data', (key: string) => {
            // Check for Ctrl+Space (usually \u0000 or \0)
            if (key === '\u0000') {
                this.toggleMode();
                return;
            }
            // Check for Ctrl+C to exit if in shell mode and no process running?
            // Or just pass it through. Node-pty handles signals usually.
            // But if we want to exit the wrapper entireley we might need a meta key.
            // For now let's rely on standard exit commands or shell exit.
            
            // Pass input to active pty
            const activePty = this.getActivePty();
            if (activePty) {
                activePty.write(key);
            }
        });
    }

    private initShell() {
        const shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
        console.log(`[DEBUG] Initializing shell: '${shell}'`);
        
        try {
            this.shellPty = pty.spawn(shell, [], {
                name: 'xterm-color',
                cols: this.dimensions.cols,
                rows: this.dimensions.rows - 1, // Reserve 1 line for status
                cwd: process.cwd(),
                env: process.env
            });

            this.shellPty.onData((data) => {
                if (this.currentMode === TerminalMode.SHELL) {
                    process.stdout.write(data);
                }
            });
            
            this.shellPty.onExit(() => {
                console.log('Shell exited. Exiting wrapper.');
                process.exit(0);
            });
        } catch (error) {
            console.error('Error spawning shell:', error);
            process.exit(1);
        }
    }

    private initClaude() {
        if (this.claudePty) return;

        // "claude" command should be in PATH
        this.claudePty = pty.spawn('claude', [], {
            name: 'xterm-color',
            cols: this.dimensions.cols,
            rows: this.dimensions.rows - 1,
            cwd: process.cwd(),
            env: process.env
        });

        this.claudePty.onData((data) => {
            if (this.currentMode === TerminalMode.CLAUDE) {
                process.stdout.write(data);
            }
        });

        this.claudePty.onExit((e) => {
           // If claude exits (e.g. user typed /exit), switch back to shell
           this.claudePty = null;
           this.isClaudeRunning = false;
           this.switchMode(TerminalMode.SHELL);
        });
        
        this.isClaudeRunning = true;
    }

    private toggleMode() {
        const newMode = this.currentMode === TerminalMode.SHELL ? TerminalMode.CLAUDE : TerminalMode.SHELL;
        this.switchMode(newMode);
    }

    private switchMode(mode: TerminalMode) {
        this.currentMode = mode;
        
        if (mode === TerminalMode.CLAUDE) {
            if (!this.claudePty) {
                this.initClaude();
            }
        }
        
        // Clear screen and redraw handled by the pty output mostly, 
        // but we might want to refresh the active terminal's screen.
        // Doing a full redraw is hard without buffer access.
        // For now, let's just accept the context switch might look messy 
        // until the next output or we can try to send a clear command.
        // Actually, just rendering the status and letting the user type might be enough.
        
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // Clear screen
        this.renderStatus();
        
        // We might want to trigger a redraw of the active pty if possible.
        // pty.resize can sometimes trigger a redraw in some apps (like vim).
        if (mode === TerminalMode.SHELL && this.shellPty) {
             this.shellPty.resize(this.dimensions.cols, this.dimensions.rows - 1);
        } else if (mode === TerminalMode.CLAUDE && this.claudePty) {
             this.claudePty.resize(this.dimensions.cols, this.dimensions.rows - 1);
        }
    }
    
    // Status Bar implementation
    private renderStatus() {
         process.stdout.write('\x1b[s'); // Save cursor position
         process.stdout.write(`\x1b[${this.dimensions.rows};1H`); // Move to bottom
         
         const modeText = this.currentMode === TerminalMode.SHELL 
            ? chalk.bgBlue.white(' SHELL ') 
            : chalk.bgMagenta.white(' CLAUDE ');
            
         const helpText = chalk.gray(' | Ctrl+Space to toggle | wrapped terminal');
         
         // Clear line and write status
         process.stdout.write('\x1b[2K'); 
         process.stdout.write(modeText + helpText);
         
         process.stdout.write('\x1b[u'); // Restore cursor position
    }

    private getActivePty(): pty.IPty | null {
        return this.currentMode === TerminalMode.SHELL ? this.shellPty : this.claudePty;
    }
    
    private resize(size: { cols: number; rows: number }) {
        this.dimensions = size;
        if (this.shellPty) {
             this.shellPty.resize(size.cols, size.rows - 1);
        }
        if (this.claudePty) {
             this.claudePty.resize(size.cols, size.rows - 1);
        }
        this.renderStatus();
    }
}
