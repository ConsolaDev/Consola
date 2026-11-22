import { AgentChat } from '../src/index.ts';

const PARAMETERS = ['host', 'pass', 'session'] as const;

type Appearance = 'dark' | 'light';

/** `?theme=dark|light`, else the system's: what Consola's `html[data-theme]` would say. */
const appearanceOf = (search: URLSearchParams): Appearance => {
  const asked = search.get('theme');
  if (asked === 'dark' || asked === 'light') return asked;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** The host is named `ws://host:port` in the brief; `AgentChat` takes `http(s)://`. */
const httpAddressOf = (host: string) => host.replace(/^ws(s?):\/\//i, 'http$1://');

/**
 * The dev page: `AgentChat` full-window against a `consola-host session --dev` on this machine.
 * `search` is the page's query string. The pass is handed to the chat and never rendered or logged.
 */
export function DevPage({ search }: { readonly search: string }) {
  const query = new URLSearchParams(search);
  const missing = PARAMETERS.filter((name) => !query.get(name));
  const host = query.get('host');
  const pass = query.get('pass');
  const session = query.get('session');
  return (
    <div data-theme={appearanceOf(query)} style={{ height: '100%' }}>
      {host && pass && session ? (
        <AgentChat hostUrl={httpAddressOf(host)} pass={pass} sessionId={session} />
      ) : (
        <p role="alert" style={{ margin: 0, padding: 24, fontFamily: 'system-ui, sans-serif' }}>
          Missing parameter{missing.length > 1 ? 's' : ''}: {missing.join(', ')}. Open{' '}
          <code>?host=ws://127.0.0.1:7420&amp;pass=&lt;dev-pass&gt;&amp;session=&lt;id&gt;</code>
        </p>
      )}
    </div>
  );
}
