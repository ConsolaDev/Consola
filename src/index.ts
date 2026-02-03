import { TerminalManager } from './TerminalManager';
import chalk from 'chalk';
import * as process from 'process';

async function main() {
    process.stdout.write('\x1b[2J\x1b[H'); // Clear screen
    console.log(chalk.green('Starting Console-1 Wrapper...'));
    console.log(chalk.gray('Integration with Claude CLI in progress.'));
    
    // Simple check if process.stdin is TTY
    if (!process.stdin.isTTY) {
        console.error(chalk.red('Error: stdin is not a TTY. This app must be run in a terminal.'));
        process.exit(1);
    }

    try {
        const terminal = new TerminalManager();
        terminal.start();
    } catch (error) {
        console.error(chalk.red('Failed to start terminal manager:'), error);
        process.exit(1);
    }
}

main().catch(console.error);
