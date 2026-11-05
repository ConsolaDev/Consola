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
 * Deliberately dependency-free: `pnpm install` here triggers a native rebuild of
 * node-pty, which is not a price worth paying for a file watcher.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
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
 * Whether a compiled file is code the running app can load.
 *
 * Only `.js` counts: declarations and source maps accompany every emit and
 * change nothing about what runs. Compiled tests (`*.test.js`,
 * `*.test-helpers.js`) are excluded too — tsconfig.main.json emits them next to
 * the app because that is how they get typechecked, but Electron never loads
 * them, so writing a test must not relaunch the app on top of whatever the
 * developer is doing.
 */
function isRuntimeOutput(fileName) {
    return fileName.endsWith('.js') && !/\.test[.-]/.test(fileName);
}

/** Every runtime file under the watched build output, in a stable order. */
function runtimeOutputs() {
    const files = [];

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
            } else if (isRuntimeOutput(entry.name)) {
                files.push(target);
            }
        }
    };

    for (const dir of watchDirs) visit(dir);
    return files.sort();
}

/** Modification time of the most recently written runtime file. */
function newestBuildTime() {
    let newest = 0;
    for (const file of runtimeOutputs()) {
        try {
            const { mtimeMs } = fs.statSync(file);
            if (mtimeMs > newest) newest = mtimeMs;
        } catch {
            // Removed between listing and stat; the next tick will see it.
        }
    }
    return newest;
}

/**
 * A digest of what the app would load: every runtime file's path and contents.
 *
 * A timestamp says a file was written, not that it changed. `pnpm build` — which
 * `test:e2e` runs first — rewrites every file with exactly what `tsc --watch`
 * already emitted, and a restart for that is pure cost: it kills the session
 * PTYs and pulls the window to the front mid-thought. Only read once the
 * timestamps have settled, so the hashing never runs on an idle poll.
 */
function buildFingerprint() {
    const hash = crypto.createHash('sha1');
    for (const file of runtimeOutputs()) {
        hash.update(path.relative(projectRoot, file));
        hash.update('\0');
        try {
            hash.update(fs.readFileSync(file));
        } catch {
            // Vanished mid-read: hashing it as missing still reads as a change.
        }
        hash.update('\0');
    }
    return hash.digest('hex');
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
        // the app, which should end `pnpm run dev` exactly as it did before.
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
    // What the running Electron was launched with; a settled rebuild that
    // matches it changed timestamps only.
    let running = buildFingerprint();

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
            const fingerprint = buildFingerprint();
            if (fingerprint === running) {
                log('Rebuilt with identical output — keeping Electron running');
                return;
            }
            running = fingerprint;
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
