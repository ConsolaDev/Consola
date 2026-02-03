import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

// Terminal mode enum (duplicated to avoid import issues in renderer)
enum TerminalMode {
    SHELL = 'SHELL',
    CLAUDE = 'CLAUDE'
}

// State
let currentMode: TerminalMode = TerminalMode.SHELL;
let escapePressed = false;
let escapeTimeout: number | null = null;

// DOM elements
const terminalContainer = document.getElementById('terminal-container')!;
const shellTab = document.getElementById('shell-tab')!;
const claudeTab = document.getElementById('claude-tab')!;
const statusMode = document.getElementById('status-mode')!;

// Initialize xterm.js
const terminal = new Terminal({
    theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#4ec9b0',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#9cdcfe',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#4ec9b0',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#9cdcfe',
        brightWhite: '#ffffff',
    },
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
});

// Addons
const fitAddon = new FitAddon();
const webLinksAddon = new WebLinksAddon();

terminal.loadAddon(fitAddon);
terminal.loadAddon(webLinksAddon);

// Open terminal in container
terminal.open(terminalContainer);
fitAddon.fit();

// Handle terminal input with escape sequence detection
terminal.onData((data: string) => {
    // Handle escape sequence for mode switching
    if (escapePressed) {
        escapePressed = false;
        if (escapeTimeout !== null) {
            clearTimeout(escapeTimeout);
            escapeTimeout = null;
        }

        if (data === 's' || data === '1') {
            switchMode(TerminalMode.SHELL);
            return;
        } else if (data === 'c' || data === '2') {
            switchMode(TerminalMode.CLAUDE);
            return;
        } else {
            // Not a mode switch command, send the original Escape + this key
            window.terminalAPI.sendInput('\x1b' + data);
            return;
        }
    }

    // Check for Escape key
    if (data === '\x1b') {
        escapePressed = true;
        escapeTimeout = window.setTimeout(() => {
            if (escapePressed) {
                escapePressed = false;
                window.terminalAPI.sendInput('\x1b');
            }
        }, 200);
        return;
    }

    // Send regular input to PTY
    window.terminalAPI.sendInput(data);
});

// Handle keyboard shortcuts (Cmd/Ctrl+1, Cmd/Ctrl+2)
document.addEventListener('keydown', (e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;

    if (isMod && e.key === '1') {
        e.preventDefault();
        switchMode(TerminalMode.SHELL);
    } else if (isMod && e.key === '2') {
        e.preventDefault();
        switchMode(TerminalMode.CLAUDE);
    }
});

// Receive data from PTY
window.terminalAPI.onData((data: string) => {
    terminal.write(data);
});

// Receive mode changes from main process
window.terminalAPI.onModeChanged((mode: TerminalMode) => {
    updateModeUI(mode);
});

// Handle window resize
window.addEventListener('resize', () => {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    if (dims) {
        window.terminalAPI.resize(dims.cols, dims.rows);
    }
});

// Initial resize
setTimeout(() => {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    if (dims) {
        window.terminalAPI.resize(dims.cols, dims.rows);
    }
}, 100);

// Mode tab click handlers
shellTab.addEventListener('click', () => {
    switchMode(TerminalMode.SHELL);
});

claudeTab.addEventListener('click', () => {
    switchMode(TerminalMode.CLAUDE);
});

// Switch mode function
function switchMode(mode: TerminalMode): void {
    if (mode === currentMode) return;

    currentMode = mode;
    window.terminalAPI.switchMode(mode);
    updateModeUI(mode);

    // Clear terminal on mode switch for cleaner experience
    terminal.clear();
}

// Update UI to reflect current mode
function updateModeUI(mode: TerminalMode): void {
    currentMode = mode;

    // Update tabs
    if (mode === TerminalMode.SHELL) {
        shellTab.classList.add('active');
        claudeTab.classList.remove('active');
        statusMode.textContent = 'SHELL';
        statusMode.classList.remove('claude');
    } else {
        shellTab.classList.remove('active');
        claudeTab.classList.add('active');
        statusMode.textContent = 'CLAUDE';
        statusMode.classList.add('claude');
    }

    // Focus terminal
    terminal.focus();
}

// Focus terminal on load
terminal.focus();
