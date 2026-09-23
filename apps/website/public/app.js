const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const previews = {
  agents: `<div class="conversation"><div class="conversation-head"><span class="claude-symbol" aria-hidden="true">✳</span>Claude Code<small>~/acme/web</small></div><div class="prompt">Let's build a better onboarding flow.<br>Keep it simple. Make it feel great.</div><p class="response-text">I'll start with the existing flow, then put the new experience together.</p><ul class="activity-list"><li>${icon('check')}Explored the app structure</li><li>${icon('check')}Created an implementation plan</li><li>${icon('check')}Updated the onboarding components</li></ul><div class="tool-output">3 files changed &nbsp; <span class="added">+86</span> <span class="removed">−12</span></div><div class="composer">What should we build next?<span aria-hidden="true">↵</span></div></div><aside class="file-pane"><div class="file-pane-title">FILES & CHANGES</div><div class="folder">⌄ &nbsp; src</div><div class="folder">&nbsp; ⌄ &nbsp; components</div><div class="file">&nbsp; &nbsp; onboarding.tsx <span>M</span></div><div class="file">&nbsp; &nbsp; welcome.tsx <span>M</span></div><div class="file">&nbsp; &nbsp; styles.css <span>M</span></div><div class="diff-count">+86 &nbsp; <span class="removed">−12</span> &nbsp; / &nbsp; 3 files</div><pre><span class="added">+ &lt;OnboardingFlow</span>\n<span class="added">+   steps={steps}</span>\n<span class="added">+   onComplete={done}</span>\n<span class="added">+ /&gt;</span></pre></aside>`,
  worktrees: `<div class="worktree-board"><div class="board-eyebrow">ONE PROJECT. MULTIPLE POSSIBILITIES.</div><h3>Give every idea its own space.</h3><p>Separate Git worktrees keep each session's changes in its own checkout.</p><div class="worktree-card">${icon('branch')}<div><strong>feat/onboarding</strong><small>Build the next big thing</small></div><span>Claude Code</span></div><div class="worktree-card">${icon('branch')}<div><strong>fix/auth</strong><small>Review authentication</small></div><span>Codex</span></div><div class="worktree-card">${icon('branch')}<div><strong>refactor/api</strong><small>Clean up the API</small></div><span>Claude Code</span></div></div>`,
  review: `<div class="review-content"><div class="review-heading">Review changes<span>3 files &nbsp; +86 −12</span></div><div class="code-diff"><div class="diff-filename">src/components/onboarding.tsx</div><pre>  export function Onboarding() {\n<span class="removed">−   return &lt;Welcome /&gt;;</span>\n<span class="added">+   return (</span>\n<span class="added">+     &lt;OnboardingFlow</span>\n<span class="added">+       steps={steps}</span>\n<span class="added">+       onComplete={done}</span>\n<span class="added">+     /&gt;</span>\n<span class="added">+   );</span>\n  }</pre></div><div class="review-footer">${icon('check')}Review, stage, and commit alongside your session.</div></div>`
};
const panel = document.querySelector('#preview-body');
const tabs = [...document.querySelectorAll('[data-preview]')];
function selectPreview(tab) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  panel.innerHTML = previews[tab.dataset.preview];
  panel.setAttribute('aria-labelledby', tab.id);
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectPreview(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectPreview(tabs[next]);
    tabs[next].focus();
  });
});
selectPreview(tabs[0]);

// Resolve versioned DMGs from the latest published, stable GitHub release.
// The HTML links remain usable if GitHub is unavailable or JavaScript is off.
async function loadDownload() {
  const repository = 'ConsolaDev/Consola';
  const status = document.querySelector('#download-status');
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
