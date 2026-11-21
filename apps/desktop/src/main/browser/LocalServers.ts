import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { LocalServer } from '../../shared/browser';
import { parseLsofFields } from '../lsofFields';
import { isWithin } from '../pathWithin';

/** How long the whole scan may take before it gives up and lists nothing. */
const SCAN_TIMEOUT_MS = 2_000;

type Run = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** A process listening on a port `localhost` reaches. */
export interface Listener {
  pid: number;
  command: string;
  port: number;
}

/**
 * The listeners in `lsof -iTCP -sTCP:LISTEN -Fpcn` output. A socket bound to
 * one specific network address is skipped: `localhost` would not reach it, so
 * offering it would only lead to an error page. One entry per process and
 * port, since a server usually listens on IPv4 and IPv6 both.
 */
export function parseListeners(output: string): Listener[] {
  const seen = new Set<string>();
  const listeners: Listener[] = [];
  for (const { pid, command, name } of parseLsofFields(output)) {
    const split = name.lastIndexOf(':');
    if (split < 0) continue;
    const host = name.slice(0, split);
    const portText = name.slice(split + 1);
    if (!/^\d+$/.test(portText) || !isLocalHost(host)) continue;
    const port = Number.parseInt(portText, 10);
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ pid, command, port });
  }
  return listeners;
}

function isLocalHost(host: string): boolean {
  return (
    host === '*' ||
    host === '[::]' ||
    host === '[::1]' ||
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  );
}

/**
 * Which servers are running from a session's folder, for the browser's empty
 * tab and the palette: a dev server the agent started is one click away.
 *
 * Two `lsof` calls, listeners first and then the working folder of just those
 * processes, kept when it is inside the session's checkout by real path (a
 * symlinked folder and a prefix-sharing sibling both resolve correctly). It
 * runs only when asked, never on a timer. `listFor` reads anything that stops
 * it answering as no servers; `scanFor` says `null` for that instead, so a
 * caller that already shows a list can keep it rather than blank it. Windows
 * is a definite empty answer.
 */
export class LocalServers {
  constructor(
    private readonly run: Run = runCommand,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async listFor(folder: string | undefined): Promise<LocalServer[]> {
    return (await this.scanFor(folder)) ?? [];
  }

  /** The servers, or null when the scan failed or ran out of time. */
  public async scanFor(folder: string | undefined): Promise<LocalServer[] | null> {
    if (!folder || this.platform === 'win32') return [];
    // One budget for both calls, not one each.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SCAN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.scan(folder), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async scan(folder: string): Promise<LocalServer[] | null> {
    try {
      const root = fs.realpathSync(folder);
      const listeners = (await this.listeners()).filter((l) => l.pid !== process.pid);
      if (listeners.length === 0) return [];
      const cwds = await this.workingFolders([...new Set(listeners.map((l) => l.pid))]);
      return (
        listeners
          .filter((listener) => {
            const cwd = cwds.get(listener.pid);
            return cwd !== undefined && isWithin(realOrSelf(cwd), root);
          })
          .sort((a, b) => a.port - b.port)
          // One row per port, whichever process answers it.
          .filter((listener, index, sorted) => sorted[index - 1]?.port !== listener.port)
          .map(({ port, command }) => ({ port, command, url: `http://localhost:${port}` }))
      );
    } catch {
      return null;
    }
  }

  private async listeners(): Promise<Listener[]> {
    const result = await this.lsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
    return parseListeners(result);
  }

  private async workingFolders(pids: number[]): Promise<Map<number, string>> {
    const result = await this.lsof(['-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
    return new Map(parseLsofFields(result).map(({ pid, name }) => [pid, name]));
  }

  /** lsof exits 1 when it skipped something it may not read; what it did print is still true. */
  private async lsof(args: string[]): Promise<string> {
    const { code, stdout } = await this.run('lsof', args);
    if (code !== 0 && code !== 1) throw new Error(`lsof exited ${code}`);
    return stdout;
  }
}

function realOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function runCommand(binary: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { maxBuffer: 8 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        // A timeout kills the child: whatever it printed is a partial answer.
        resolve({ code: error?.killed ? -1 : code, stdout: String(stdout) });
      },
    );
  });
}
