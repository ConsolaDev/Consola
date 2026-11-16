// PostHog, reached through this site's own origin. The browser only ever talks to
// /cnsl on consola.dev; vercel.json rewrites that path onto PostHog's EU ingestion
// and asset hosts. So no visitor request goes to a third-party domain, and ad
// blockers — which match PostHog's own hostnames — leave the numbers intact. The
// path is deliberately not /analytics or /tracking, which blocklists do match.
//
// Cookieless: no cookies, no localStorage, no consent banner. Visitors are counted
// by a hash PostHog derives server-side, which is what rules out session replay,
// surveys and GeoIP — none of which this site wants. 'never' person profiles make
// identify() a no-op, so no persistent per-person identity can be created by
// accident. This requires Settings → Project → Web analytics → "Enable cookieless
// tracking" on the PostHog project; with it off, PostHog discards these events.
//
// Autocapture is off. Every click on a landing page is more than this site needs
// and more than it promises to collect: pageviews plus one explicit 'download'
// event are the whole dataset. 'defaults' is pinned to a dated version so that a
// later posthog-js upgrade cannot quietly change what gets collected.
//
// The key is publishable and lands in the bundle either way, but reading it from
// the environment keeps it out of git and rotatable without a commit. Without one
// — local dev, previews, CI — PostHog is never even fetched and every call below
// is a no-op, so the test suite makes no analytics requests at all.
//
// The demo iframe stays untracked, as it was before: it loads demo/main.tsx rather
// than this module, so it is excluded by default. Counting it would add a second
// pageview every time a visitor scrolls the landing page, reading one visit as two.
//
// posthog-js is ~125 kB gzipped against this module's own ~1.6 kB, and none of it
// is needed to paint the page or resolve a download, so it is imported on demand
// and Vite gives it a chunk of its own, not modulepreloaded. The landing page's
// critical script ends up smaller than it was before any analytics existed. The
// .catch is what makes this promise safe to await from inside loadDownload's try
// block: a failed chunk must cost a measurement, never a download.
const analyticsKey = import.meta.env.VITE_POSTHOG_KEY;
const analytics = analyticsKey
  ? import('posthog-js')
      .then(({ default: posthog }) => {
        posthog.init(analyticsKey, {
          api_host: '/cnsl',
          ui_host: 'https://eu.posthog.com',
          defaults: '2026-08-30',
          cookieless_mode: 'always',
          person_profiles: 'never',
          autocapture: false,
        });
        // What PostHog's own snippet install exposes, and what its browser toolbar
        // and posthog.debug() both reach for. Importing from npm would otherwise
        // keep the instance inside this module's closure, leaving a live page with
        // nothing to inspect.
        window.posthog = posthog;
        return posthog;
      })
      .catch(() => null)
  : null;

// Resolve versioned DMGs from the latest published, stable GitHub release.
// The HTML links remain usable if GitHub is unavailable or JavaScript is off.
async function loadDownload() {
  const repository = 'ConsolaDev/Consola';
  const status = document.querySelector('#download-status');
  const downloadPage = document.querySelector('[data-download-page]');
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
  // iPadOS can report MacIntel when browsing desktop sites.
  const isMac = /mac/i.test(platform) && !(navigator.maxTouchPoints > 1) &&
    !/iPad|iPhone|iPod|Android/i.test(navigator.userAgent);
  if (!isMac) {
    status.textContent = 'Consola is currently available for macOS. View GitHub Releases for downloads.';
    return;
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 404) {
      status.textContent = 'The first macOS release is coming soon. Check GitHub for releases.';
      return;
    }
    if (!response.ok) throw new Error('GitHub releases unavailable');
    const release = await response.json();
    if (release.draft || release.prerelease) throw new Error('No stable release available');
    const installer = (arch) => release.assets.find((asset) =>
      asset.state === 'uploaded' && asset.size > 0 &&
      new RegExp(`^Consola-.+-${arch}\\.dmg$`, 'i').test(asset.name) &&
      asset.browser_download_url?.startsWith(`https://github.com/${repository}/releases/download/`)
    );
    const appleSilicon = installer('arm64');
    const intel = installer('x64');
    const requestedArch = new URLSearchParams(location.search).get('arch');
    const primary = downloadPage && requestedArch === 'x64' ? intel
      : downloadPage && requestedArch === 'arm64' ? appleSilicon : appleSilicon || intel;
    if (!primary) {
      status.textContent = 'No macOS installer is attached to the latest release. Check GitHub for downloads.';
      return;
    }
    const archSlug = primary === appleSilicon ? 'arm64' : 'x64';
    const architecture = primary === appleSilicon ? 'Apple silicon' : 'Intel';
    const downloadPath = `/download/?arch=${archSlug}`;
    document.querySelectorAll('[data-download-link]').forEach((item) => {
      item.href = downloadPath;
      item.setAttribute('aria-label', `Download for macOS (${architecture})`);
    });
    document.querySelectorAll('[data-download-label]').forEach((item) => {
      item.textContent = item.dataset.downloadLabel === 'short' ? 'Download' : 'Download for macOS';
    });
    if (!downloadPage && appleSilicon && intel) {
      const intelLink = document.querySelector('#download-intel');
      intelLink.href = '/download/?arch=x64';
      intelLink.hidden = false;
    }
    document.querySelector('[data-availability]').textContent = `macOS · ${architecture}`;
    status.textContent = `${release.tag_name} · ${architecture} · DMG installer`;
    if (downloadPage) {
      const retry = document.querySelector('[data-download-retry]');
      retry.href = primary.browser_download_url;
      retry.textContent = 'Click here';
      document.querySelector('[data-download-message]').textContent = ' if your download hasn’t started.';
      retry.click();
      // Downloads are counted here, where the installer transfer actually starts,
      // rather than on the landing page's buttons: those only navigate to this page,
      // which its own pageview already counts, and a pageview cannot tell a started
      // download from a visitor who arrived on a non-Mac or while GitHub was
      // unreachable — both return before this line. Fired after the click so
      // instrumentation can never stand between a visitor and the installer, and only
      // for this automatic start, so someone who also clicks the retry link stays one
      // download rather than two.
      (await analytics)?.capture('download', { arch: archSlug, version: release.tag_name });
    }
  } catch {
    status.textContent = 'Check GitHub releases for the latest macOS download.';
  }
}
loadDownload();

// The product demo uses the actual desktop renderer in an isolated iframe.
const demoFrame = document.querySelector('[data-live-demo] iframe');
let demoReady = false;
let pendingCommand;
function sendDemoCommand(command) {
  if (!demoFrame) return;
  if (!demoReady) { pendingCommand = command; return; }
  demoFrame.contentWindow.postMessage({ type: 'consola:demo-command', command }, location.origin);
  if (command === 'reset') demoReady = false;
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== demoFrame?.contentWindow) return;
  if (event.data?.type === 'consola:demo-view') {
    document.querySelectorAll('.live-demo-shortcuts [data-demo-command]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.demoCommand === event.data.view));
    });
    return;
  }
  if (event.data?.type !== 'consola:demo-ready') return;
  demoReady = true;
  if (pendingCommand) { const command = pendingCommand; pendingCommand = undefined; sendDemoCommand(command); }
});
document.querySelectorAll('[data-demo-command]').forEach(button => {
  button.addEventListener('click', () => sendDemoCommand(button.dataset.demoCommand));
});
document.querySelectorAll('[data-demo-launch]').forEach(link => {
  link.addEventListener('click', () => sendDemoCommand(link.dataset.demoLaunch));
});
