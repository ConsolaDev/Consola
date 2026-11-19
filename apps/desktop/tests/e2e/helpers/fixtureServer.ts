import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  port: number;
  /** `127.0.0.1:<port>`, the way a person types it. */
  host: string;
  url(pathname: string): string;
  /** How many times each path has been requested. */
  hits(pathname: string): number;
  close(): Promise<void>;
}

/**
 * Reports every `*API` the page can see, plus the Node globals a page must
 * never see, into `window.__probe` and the title. The names listed cover what
 * the preload hands the host window, in case an exposed one is not matched by
 * the `API` suffix scan.
 */
const PROBE_SCRIPT = `
  const found = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    if (/API$/.test(key)) found.push(key);
  }
  for (const name of ['terminalAPI', 'browserAPI', 'workspaceAPI', 'fileAPI', 'gitAPI',
    'dialogAPI', 'windowAPI', 'shellAPI', 'harnessAPI', 'harnessStateAPI']) {
    if (typeof window[name] !== 'undefined' && !found.includes(name)) found.push(name);
  }
  for (const name of ['require', 'process', 'module', 'electron', 'Buffer']) {
    if (typeof window[name] !== 'undefined') found.push(name);
  }
  window.__probe = { ran: true, found: found };
  document.title = 'probe:' + JSON.stringify(window.__probe);
`;

function page(title: string, colour: string, body = ''): string {
  return `<!doctype html><html><head><title>${title}</title></head>
<body style="margin:0;background:${colour}">${body}</body></html>`;
}

/**
 * A loopback HTTP server on a random port serving the pages the browser
 * tests drive. Started and stopped by the spec, so nothing outlives a run.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const counts = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };
    switch (pathname) {
      case '/a.html':
        return send(200, page('Page A', 'rgb(255,0,0)', '<a id="to-b" href="/b.html">go to b</a>'));
      case '/find.html':
        // Three matches of one word, for the find bar's count.
        return send(
          200,
          page(
            'Find me',
            'rgb(240,240,240)',
            '<p>needle one</p><p>needle two</p><p>needle three</p>',
          ),
        );
      case '/find2.html':
        return send(200, page('Find again', 'rgb(230,230,230)', '<p>needle</p><p>needle</p>'));
      case '/b.html':
        return send(200, page('Page B', 'rgb(0,0,255)'));
      case '/c.html':
        return send(200, page('Page C', 'rgb(0,255,0)'));
      case '/opener.html':
        // A new-tab link, and a button that opens a sized popup. The script
        // records what `window.open` returned, so a test can tell a refusal
        // (null) from a window that opened.
        return send(
          200,
          page(
            'Opener',
            'rgb(200,200,200)',
            `<a id="blank-link" href="/b.html" target="_blank">new tab</a>
<button id="pop" onclick="window.popup = window.open('/popup.html', 'p', 'width=420,height=320'); document.title = 'opened:' + (window.popup !== null)">pop</button>
<button id="pop2" onclick="window.popup2 = window.open('/popup.html', 'q', 'width=420,height=320'); document.title = 'opened:' + (window.popup2 !== null)">pop2</button>
<button id="evil" onclick="window.popup = window.open('/popup.html', 'p', 'width=420,height=320,frame=no,alwaysOnTop=yes,closable=no,movable=no,modal=yes,minWidth=5000,minHeight=5000,enableLargerThanScreen=yes,x=0,y=0,transparent=yes,skipTaskbar=yes,title=Your bank,nodeIntegration=yes,sandbox=no,contextIsolation=no,webSecurity=no'); document.title = 'opened:' + (window.popup !== null)">evil</button>`,
          ),
        );
      case '/popup.html':
        // Tries to open a window of its own, which must be refused.
        return send(
          200,
          `<!doctype html><html><head><title>popup</title></head><body><script>
            const nested = window.open('/c.html', 'n', 'width=300,height=300');
            document.title = 'popup:nested-' + (nested === null ? 'denied' : 'open');
          </script></body></html>`,
        );
      case '/probe.html':
        return send(
          200,
          `<!doctype html><html><head><title>probing</title></head><body><script>${PROBE_SCRIPT}</script></body></html>`,
        );
      case '/secret.html': {
        // Basic auth: `ada` / `lovelace`. Anything else is asked again.
        const expected = `Basic ${Buffer.from('ada:lovelace').toString('base64')}`;
        if (req.headers.authorization === expected) {
          return send(200, page('Secret', 'rgb(0,128,0)'));
        }
        return send(401, page('Unauthorized', 'rgb(128,0,0)'), {
          'www-authenticate': 'Basic realm="Fixture area"',
        });
      }
      case '/fetch-secret.html':
        // Asks for the protected page in the background, which must never prompt.
        return send(
          200,
          `<!doctype html><html><head><title>fetching</title></head><body><script>
            fetch('/secret.html').then((r) => { document.title = 'fetched:' + r.status; });
          </script></body></html>`,
        );
      case '/set-cookie.html':
        return send(200, page('Cookie set', 'rgb(255,255,0)'), {
          'set-cookie': 'fixture=signed-in; Path=/; Max-Age=3600',
        });
      default:
        return send(404, page('Not found', 'rgb(128,128,128)'));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    host: `127.0.0.1:${port}`,
    url: (pathname) => `http://127.0.0.1:${port}${pathname}`,
    hits: (pathname) => counts.get(pathname) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
