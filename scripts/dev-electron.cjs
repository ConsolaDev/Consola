#!/usr/bin/env node
/**
 * Run Electron in development, restarting it when the main process is rebuilt.
 *
 * Vite hot-reloads the renderer, so a UI change is visible immediately — but
 * `src/main` and `src/preload` are compiled ahead of time and loaded once, at
 * launch. Without this, editing an IPC handler leaves the new UI talking to a
 * process built hours earlier: calls fail as unregistered channels, and options
 * the renderer sends are read by code that does not know about them yet. The
 * symptoms look like renderer bugs, which is what makes it expensive.
 *
 * Watches the compiled output rather than the sources, so a restart happens
 * after `tsc --watch` has finished writing — never on a half-emitted build.
 *
 * Deliberately dependency-free: `npm install` here triggers a native rebuild of
 * node-pty, which is not a price worth paying for a file watcher.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const electronBinary = require('electron');

const projectRoot = path.join(__dirname, '..');
const mainEntry = path.join(projectRoot, 'dist/main/main/index.js');
const watchDirs = [
    path.join(projectRoot, 'dist/main'),
    path.join(projectRoot, 'dist/preload'),
];

/**
 * How often the build output is scanned for a newer file.
 *
 * Polled rather than event-driven on purpose. `fs.watch` is cheaper, but when
 * its platform notifications do not arrive it fails *silently* — leaving a
 * stale Electron running behind a fresh UI, which is the exact failure this
 * script exists to prevent. Stat-ing a few dozen files a second costs nothing
 * measurable and cannot fail quietly.
 */
const POLL_MS = 400;
/** How long Electron gets to exit on its own before it is killed outright. */
const SHUTDOWN_GRACE_MS = 3000;
/** Poll interval while waiting for the first compile to produce an entry point. */
const ENTRY_POLL_MS = 200;

let child = null;
let restarting = false;
let shuttingDown = false;

function log(message) {
    console.log(`[dev-electron] ${message}`);
}

/**
 * Modification time of the most recently written compiled file.
 *
 * Only `.js` is considered: declarations and source maps accompany every emit
 * and change nothing about what actually runs.
 */
function newestBuildTime() {
    let newest = 0;

    const visit = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            // Removed mid-scan, or not compiled yet; the next tick will see it.
            return;
        }
        for (const entry of entries) {
            const target = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(target);
            } else if (entry.name.endsWith('.js')) {
                try {
                    const { mtimeMs } = fs.statSync(target);
                    if (mtimeMs > newest) newest = mtimeMs;
                } catch {
                    // Same race as above.
                }
            }
        }
    };

    for (const dir of watchDirs) visit(dir);
    return newest;
}

function startElectron() {
    child = spawn(electronBinary, ['.'], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'development' },
    });

    child.on('exit', (code, signal) => {
        child = null;
        // A restart kills the process itself; anything else is the user closing
        // the app, which should end `npm run dev` exactly as it did before.
        if (restarting || shuttingDown) return;
        log(`Electron exited (${signal ?? code}). Stopping.`);
        process.exit(code ?? 0);
    });
}

function stopElectron() {
    return new Promise((resolve) => {
        if (!child) {
            resolve();
            return;
        }

        const target = child;
        const forceKill = setTimeout(() => target.kill('SIGKILL'), SHUTDOWN_GRACE_MS);

        target.once('exit', () => {
            clearTimeout(forceKill);
            resolve();
        });

        // Takes the session PTYs down with it — they are children of this
        // process and belong to the build being replaced.
        target.kill('SIGTERM');
    });
}

async function restart() {
    restarting = true;
    log('Main process rebuilt — restarting Electron');
    await stopElectron();
    if (shuttingDown) return;
    restarting = false;
    startElectron();
}

/**
 * Restart once the build output has stopped changing.
 *
 * A single compile rewrites many files over several hundred milliseconds, so a
 * new timestamp has to repeat on two consecutive ticks before it counts as
 * settled. Restarting on the first sighting would relaunch against a
 * half-written build.
 */
function watchBuildOutput() {
    let settled = newestBuildTime();
    let pending = null;

    setInterval(() => {
        if (shuttingDown || restarting) return;

        const newest = newestBuildTime();
        if (newest <= settled) {
            pending = null;
            return;
        }

        if (pending === newest) {
            settled = newest;
            pending = null;
            restart().catch((error) => {
                console.error('[dev-electron] Restart failed:', error);
                process.exit(1);
            });
            return;
        }

        pending = newest;
    }, POLL_MS).unref();
}

/** Wait for the first compile, so a cold checkout does not fail to launch. */
function waitForEntry() {
    return new Promise((resolve) => {
        if (fs.existsSync(mainEntry)) {
            resolve();
            return;
        }
        log('Waiting for the main process to compile...');
        const timer = setInterval(() => {
            if (!fs.existsSync(mainEntry)) return;
            clearInterval(timer);
            resolve();
        }, ENTRY_POLL_MS);
    });
}

async function main() {
    await waitForEntry();
    startElectron();
    watchBuildOutput();
    log('Watching dist/main and dist/preload for rebuilds');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        shuttingDown = true;
        stopElectron().finally(() => process.exit(0));
    });
}

main().catch((error) => {
    console.error('[dev-electron] Failed to start:', error);
    process.exit(1);
});
