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

/** Where a page's address is read and replaced: the window's, or a test's stand-in. */
type AddressBar = {
  readonly location: { readonly href: string };
  readonly history: {
    readonly state: unknown;
    replaceState(state: unknown, unused: string, url: URL): void;
  };
};

/**
 * Takes `pass` out of the page's address once it has been read, keeping every other parameter
 * (`host`, `session`, `theme`): the history entry is replaced, so the pass is left in neither
 * the address bar nor the history. A reload then names `pass` as missing.
 */
export function forgetPassInAddress(bar: AddressBar = window): void {
  const url = new URL(bar.location.href);
  if (!url.searchParams.has('pass')) return;
  url.searchParams.delete('pass');
  bar.history.replaceState(bar.history.state, '', url);
}

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
