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

// Keep an unavailable installer honest. Set download.json.url to a public
// HTTPS installer URL when a release is available; all CTAs update together.
async function loadDownload() {
  try {
    const response = await fetch('download.json');
    if (!response.ok) throw new Error('Download configuration unavailable');
    const config = await response.json();
    if (!config.url) {
      document.querySelector('#download-status').textContent = config.unavailableMessage || 'The macOS download is coming soon.';
      return;
    }
    const url = new URL(config.url);
    if (url.protocol !== 'https:') throw new Error('Installer URL must use HTTPS');
    const label = config.label || 'Download for macOS';
    const link = document.createElement('a');
    link.className = 'button button-primary';
    link.href = url.href;
    link.innerHTML = icon('down');
    link.append(document.createTextNode(label));
    document.querySelector('#download-action').replaceChildren(link);
    document.querySelectorAll('[data-download-link]').forEach((item) => { item.href = url.href; });
    document.querySelectorAll('[data-download-label]').forEach((item) => { item.textContent = label; });
    document.querySelector('[data-availability]').textContent = `macOS · ${config.detail || 'Apple silicon'}`;
    document.querySelector('#download-status').textContent = config.detail || 'For Apple silicon';
  } catch {
    document.querySelector('#download-status').textContent = 'The download is not available right now. Please check back soon.';
  }
}
loadDownload();
