// Resolve versioned DMGs from the latest published, stable GitHub release.
// The HTML links remain usable if GitHub is unavailable or JavaScript is off.
async function loadDownload() {
  const repository = 'ConsolaDev/Consola';
  const status = document.querySelector('#download-status');
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
    const primary = appleSilicon || intel;
    if (!primary) {
      status.textContent = 'No macOS installer is attached to the latest release. Check GitHub for downloads.';
      return;
    }
    const architecture = appleSilicon ? 'Apple silicon' : 'Intel';
    document.querySelectorAll('[data-download-link]').forEach((item) => {
      item.href = primary.browser_download_url;
      item.setAttribute('aria-label', `Download for macOS (${architecture})`);
    });
    document.querySelectorAll('[data-download-label]').forEach((item) => {
      item.textContent = item.dataset.downloadLabel === 'short' ? 'Download' : 'Download for macOS';
    });
    if (appleSilicon && intel) {
      const intelLink = document.querySelector('#download-intel');
      intelLink.href = intel.browser_download_url;
      intelLink.hidden = false;
    }
    document.querySelector('[data-availability]').textContent = `macOS · ${architecture}`;
    status.textContent = `${release.tag_name} · ${architecture} · DMG installer`;
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
