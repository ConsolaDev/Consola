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
      case '/agent.html':
        // What an agent reads: a heading, a field and a button to ref, and,
        // as it loads, a console error, an uncaught error, an HTTP error and
        // a network error (port 9 is one Chromium always refuses). Red, so a
        // screenshot shows it painted.
        return send(
          200,
          page(
            'Agent fixture',
            'rgb(255,0,0)',
            `<h1>Agent fixture</h1>
<label>Name <input id="name"></label>
<button id="go" onclick="document.title = 'Hi, ' + document.getElementById('name').value">Greet</button>
<img src="/agent-missing.png" alt="" width="1" height="1">
<script>
  console.error('fixture: something broke');
  setTimeout(() => { throw new Error('fixture: uncaught'); }, 0);
  fetch('http://127.0.0.1:9/unreachable').catch(() => {});
</script>`,
          ),
        );
      case '/agent-act.html':
        // What an agent acts on: a button that counts its clicks, a search
        // form whose answer arrives a moment after Enter, a file input, a
        // button that asks a confirm, and a link to a file. It counts the
        // trusted presses it hears (only the person's are), and cancels any
        // click that reaches its file input, so no chooser could open
        // whatever the app let through.
        return send(
          200,
          page(
            'Act fixture',
            'rgb(255,255,255)',
            `<h1>Act fixture</h1>
<p><button id="count">Count</button> <span id="clicks">Not clicked</span></p>
<form id="search"><label>Query <input id="q" name="q"></label></form>
<p id="result">No search yet</p>
<p><label>Attachment <input id="file" type="file"></label></p>
<p><button id="delete">Delete</button> <span id="answer">Not asked</span></p>
<p><a id="dl" href="/report.csv">Download report</a></p>
<script>
  const byId = (id) => document.getElementById(id);
  let clicks = 0;
  window.__fileClicks = 0;
  window.__presses = 0;
  byId('count').addEventListener('click', () => {
    clicks += 1;
    byId('clicks').textContent = 'Clicked ' + clicks;
  });
  byId('search').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = byId('q').value;
    byId('result').textContent = 'Searching for ' + query;
    setTimeout(() => { byId('result').textContent = 'Found ' + query; }, 300);
  });
  byId('delete').addEventListener('click', () => {
    byId('answer').textContent = 'Answered ' + confirm('Delete everything?');
  });
  document.addEventListener('click', (event) => {
    if (event.target === byId('file')) {
      window.__fileClicks += 1;
      event.preventDefault();
    }
  }, true);
  document.addEventListener('mousedown', (event) => {
    if (event.isTrusted) window.__presses += 1;
  }, true);
</script>`,
          ),
        );
      case '/report.csv':
        // A file, which a browser downloads rather than shows.
        res.writeHead(200, {
          'content-type': 'text/csv',
          'content-disposition': 'attachment; filename="report.csv"',
        });
        return res.end('a,b\n1,2\n');
      case '/download.html':
        return send(
          200,
          page('Download', 'rgb(220,220,255)', '<a id="dl" href="/report.csv">report</a>'),
        );
      case '/later.html':
        // Starts a download on its own, well after it has loaded.
        return send(
          200,
          page(
            'Later',
            'rgb(255,220,220)',
            `<script>setTimeout(() => { location.href = '/report.csv'; }, 4000);</script>`,
          ),
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
