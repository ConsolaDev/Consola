// Only the Electron boundary is mocked. All product components and stores are
// imported unchanged from the desktop renderer. Nothing executes or leaves the browser.
import { workspaces as seedWorkspaces, harnesses as seedHarnesses, inboxes, files, diff } from './fixtures';
import { substitutePlaceholders } from '../../desktop/src/shared/workItemPrompt';
import type { Workspace, Session, NewSessionFields } from '../../desktop/src/shared/workspace';
import type { WorkspaceView, TerminalCreateOptions } from '../../desktop/src/shared/types';
import type { GitStatusResult } from '../../desktop/src/renderer/types/electron';

function channel<T>() {
  const listeners = new Set<(value: T) => void>();
  return { subscribe: (fn: (value: T) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, emit: (value: T) => listeners.forEach(fn => fn(structuredClone(value))) };
}
export function notify(message: string) {
  document.dispatchEvent(new CustomEvent('demo:notice', { detail: message }));
}
const noSubscription = () => () => {};
const workspaceEvents = channel<Workspace[]>();
const dataEvents = channel<{ instanceId: string; data: string }>();
const inboxEvents = channel<any>();
const harnessEvents = channel<any>();
const workspaceChanged = channel<string | null>();
const workspaces = structuredClone(seedWorkspaces);
const harnesses = structuredClone(seedHarnesses);
const views = new Map<string, WorkspaceView>();
const transcripts = new Map<string, string>();
const inputs = new Map<string, string>();
const prompts = new Map<string, string>();
const changes = new Map<string, GitStatusResult['files']>();
let sequence = 0;
function workspace(id: string) { const value = workspaces.find(w => w.id === id); if (!value) throw new Error('Choose a demo workspace.'); return value; }
function publish() { workspaceEvents.emit(workspaces); }
function cwdFor(instanceId: string) {
  const w = workspaces.find(w => w.sessions.some(s => s.instanceId === instanceId));
  return w?.sessions.find(s => s.instanceId === instanceId)?.cwd || w?.scopes[0]?.path || '/demo/acme/platform';
}
function snapshot(id: string) { return { workspaceId: id, items: inboxes[id] || [], fetchedAt: Date.now() }; }
function createSession(workspaceId: string, fields: Partial<NewSessionFields>): Session {
  const w = workspace(workspaceId);
  const id = crypto.randomUUID();
  const record = { id, workspaceId, instanceId: `demo-${id}`, claudeSessionId: id, name: 'New Session', nameIsUserSet: true, hasStarted: false, harnessId: w.defaultHarnessId, scopeId: w.scopes[0].id, kind: 'interactive' as const, createdAt: Date.now(), lastActiveAt: Date.now(), ...fields };
  w.sessions.push(record); publish(); return structuredClone(record);
}
function write(instanceId: string, text: string) {
  transcripts.set(instanceId, (transcripts.get(instanceId) || '') + text);
  dataEvents.emit({ instanceId, data: text });
}
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
function initialTerminal(options: TerminalCreateOptions) {
  const codex = options.driverId === 'codex';
  const prompt = prompts.get(options.instanceId) || options.initialPrompt;
  const title = codex ? '›_ Codex' : '✳ Claude Code';
  if (options.instanceId === 'demo-retry') return `${cyan(title)}\r\n${options.cwd}\r\n\r\n❯ Review PR #248 and fix the retry guard.\r\n\r\n${green('✓')} Read the PR diff and traced error handling.\r\n${green('✓')} Added a guard for non-retryable errors.\r\n${green('✓')} Added a regression test.\r\n${green('✓')} 8 tests passed (sample result).\r\n\r\nThe changes are ready for your review.\r\nInspect the diff, approve files, and try a commit.\r\n\r\n${cyan('Interactive demo · simulated agent output')}\r\nTry "run tests" or "help".\r\n\r\n❯ `;
  return `\x1b[1m${cyan(title)}\x1b[0m\r\n${options.cwd}\r\n\r\n${prompt ? `❯ ${prompt}\r\n\r\n` : ''}${prompt ? `${green('✓')} Read the pull request and related tests.\r\n\r\nFound an edge case: client errors are retried.\r\nAdd an isRetryable guard and a regression test.\r\n\r\n` : `${green('✓')} Your session is ready.\r\n\r\n`}${cyan('Interactive demo · simulated agent output')}\r\nTry "fix the retry guard", "run tests", or "help".\r\n\r\n❯ `;
}
function submit(instanceId: string, input: string) {
  const message = input.trim();
  write(instanceId, '\r\n\r\n');
  if (/fix|implement|guard|change|build/i.test(message)) {
    const cwd = cwdFor(instanceId);
    changes.set(cwd, [{ path: 'src/lib/retry.ts', status: 'modified' }, { path: 'src/lib/retry.test.ts', status: 'untracked' }]);
    write(instanceId, `${green('✓')} Added the retry guard and regression test.\r\n${green('✓')} 8 tests passed.\r\n\r\nThe sample changes are ready in Git Changes.\r\n`);
    document.dispatchEvent(new CustomEvent('demo:changes', { detail: cwd }));
  } else if (/test/i.test(message)) {
    write(instanceId, `${green('PASS')} src/lib/retry.test.ts\r\n${green('✓')} 8 tests passed (sample result).\r\n`);
  } else if (/review|diff/i.test(message)) {
    write(instanceId, 'Review finding: retry only transient failures.\r\nTry "fix the retry guard" to apply the sample fix.\r\n');
  } else {
    write(instanceId, 'This browser demo uses sample responses, not a live agent.\r\nTry "fix the retry guard", "run tests", or open Inbox\r\nand launch a PR action. Nothing is sent to a service.\r\n');
  }
  write(instanceId, '\r\n❯ ');
}
function input(instanceId: string, data: string) {
  for (const char of data.replace(/\x1b\[200~|\x1b\[201~/g, '')) {
    const current = inputs.get(instanceId) || '';
    if (char === '\r' || char === '\n') { inputs.set(instanceId, ''); submit(instanceId, current); }
    else if (char === '\x7f') { if (current) { inputs.set(instanceId, current.slice(0, -1)); write(instanceId, '\b \b'); } }
    else if (char >= ' ' && char !== '\x7f') { inputs.set(instanceId, current + char); write(instanceId, char); }
  }
}
export function installMock() {
  // Desktop stores may persist UI preferences. Keep this demo entirely in memory,
  // separate from the host site's storage, and reset it by reloading the iframe.
  const memory = new Map<string, string>();
  const storage: Storage = { get length() { return memory.size; }, clear: () => memory.clear(), getItem: key => memory.get(key) ?? null, key: index => [...memory.keys()][index] ?? null, removeItem: key => { memory.delete(key); }, setItem: (key, value) => { memory.set(key, String(value)); } };
  Object.defineProperty(window, 'localStorage', { value: storage });
  storage.setItem('consola-settings', JSON.stringify({ state: { theme: 'dark', terminalFontSize: 12 }, version: 0 }));

  window.windowAPI = {
    context: { workspaceId: 'acme', activeSessionId: 'onboarding', isInboxOpen: false },
    activateWorkspace: async id => ({ verdict: 'took', view: views.get(id || '') || { activeSessionId: workspaces.find(w => w.id === id)?.sessions[0]?.id || null, isInboxOpen: true } }),
    setView: (id, view) => { if (id) views.set(id, view); },
    onWorkspaceChanged: workspaceChanged.subscribe, onActivateSession: noSubscription, onOpenSettings: noSubscription,
    openWindow: async id => { if (id) workspaceChanged.emit(id); else notify('The desktop app can open additional windows. This demo stays in one browser frame.'); },
  };
  window.workspaceAPI = {
    getSnapshot: async () => ({ workspaces: structuredClone(workspaces), needsImport: false }), importState: async () => false,
    onChanged: workspaceEvents.subscribe,
    createWorkspace: async (name, path, isGitRepo, defaultHarnessId) => { const id = crypto.randomUUID(); const w = { ...structuredClone(seedWorkspaces[1]), id, name, defaultHarnessId: defaultHarnessId || 'codex-personal', scopes: [{ id: `${id}-repo`, name, path, isGitRepo, createdAt: Date.now() }], sessions: [], groups: [] }; workspaces.push(w); publish(); return structuredClone(w); },
    updateWorkspace: async (id, updates) => { Object.assign(workspace(id), updates); publish(); },
    deleteWorkspace: async id => { const index = workspaces.findIndex(w => w.id === id); if (index >= 0) workspaces.splice(index, 1); publish(); },
    moveWorkspace: async (id, before) => { const w = workspace(id); workspaces.splice(workspaces.indexOf(w), 1); const index = workspaces.findIndex(w => w.id === before); workspaces.splice(index < 0 ? workspaces.length : index, 0, w); publish(); },
    createSession: async (id, fields, checkout) => { const record = createSession(id, fields); if (checkout?.mode === 'new') { const saved = workspace(id).sessions.find(s => s.id === record.id)!; saved.cwd = `${workspace(id).scopes[0].path}/.worktrees/${checkout.branchName || 'demo'}`; publish(); return structuredClone(saved); } return record; },
    updateSession: async (id, sessionId, updates) => { Object.assign(workspace(id).sessions.find(s => s.id === sessionId)!, updates); publish(); },
    deleteSession: async (id, sessionId) => { const w = workspace(id); w.sessions = w.sessions.filter(s => s.id !== sessionId); publish(); },
    createGroup: async (id, fields) => { const group = { id: crypto.randomUUID(), createdAt: Date.now(), ...fields }; workspace(id).groups.push(group); publish(); return structuredClone(group); },
    updateGroup: async (id, groupId, fields) => { Object.assign(workspace(id).groups.find(g => g.id === groupId)!, fields); publish(); },
    archiveGroup: async (id, groupId) => { workspace(id).groups.find(g => g.id === groupId)!.archivedAt = Date.now(); publish(); },
    restoreGroup: async (id, groupId) => { delete workspace(id).groups.find(g => g.id === groupId)!.archivedAt; publish(); },
    addScope: async (id, fields) => { const scope = { id: crypto.randomUUID(), createdAt: Date.now(), ...fields }; workspace(id).scopes.push(scope); publish(); return structuredClone(scope); },
    updateScope: async (id, scopeId, fields) => { Object.assign(workspace(id).scopes.find(s => s.id === scopeId)!, fields); publish(); },
    removeScope: async (id, scopeId) => { const w = workspace(id); if (w.sessions.some(s => s.scopeId === scopeId)) throw new Error('This repository still has sessions.'); w.scopes = w.scopes.filter(s => s.id !== scopeId); publish(); },
    setProviderBinding: async (id, binding) => { workspace(id).provider = binding || undefined; publish(); },
    setActions: async (id, actions, sectionDefaults) => { Object.assign(workspace(id), { actions, sectionDefaults }); publish(); },
    listScopeRepos: async id => workspace(id).scopes.map(s => ({ name: s.name, path: s.path })),
    checkoutContext: async id => ({ branch: 'main', refs: ['main', 'feat/onboarding'], localBranches: ['main', 'feat/onboarding'], worktrees: [{ path: workspace(id).scopes[0].path, branch: 'main', head: 'demo123', current: true }] }),
    fanOut: async intent => { const group = await window.workspaceAPI.createGroup(intent.workspaceId, { name: intent.groupName }); const created = intent.targetPaths.map(path => createSession(intent.workspaceId, { scopeId: intent.scopeId, groupId: group.id, name: intent.groupName, cwd: path })); return { group, created, failed: [] }; },
  };
  window.harnessStateAPI = {
    getSnapshot: async () => ({ harnesses: structuredClone(harnesses), needsImport: false }), importState: async () => false, onChanged: harnessEvents.subscribe,
    addHarness: async fields => { const h = { enabled: true, archived: false, isBuiltIn: false, extraArgs: [], createdAt: Date.now(), updatedAt: Date.now(), ...fields }; harnesses.push(h); harnessEvents.emit(harnesses); return h; },
    updateHarness: async (id, fields) => { Object.assign(harnesses.find(h => h.id === id)!, fields); harnessEvents.emit(harnesses); },
    archiveHarness: async id => { harnesses.find(h => h.id === id)!.archived = true; harnessEvents.emit(harnesses); },
    restoreHarness: async id => { harnesses.find(h => h.id === id)!.archived = false; harnessEvents.emit(harnesses); },
  };
  window.harnessAPI = {
    probe: async fields => ({ available: true, version: 'Demo', resolvedBinary: fields.driverId || 'claude' }),
    getSessionName: async () => null, getSessionModel: async () => null,
    getCapabilities: async () => ({ supported: false, reason: 'Live CLI discovery is available in the desktop app.' }),
  };
  window.inboxAPI = { getInbox: async id => snapshot(id), refreshInbox: async id => { inboxEvents.emit(snapshot(id)); }, onInboxChanged: inboxEvents.subscribe };
  window.providerAPI = {
    probe: async () => ({ available: true, version: 'Demo', accounts: [{ login: 'alex-work', active: true }, { login: 'alex-builds', active: false }] }),
    resolveRepos: async (id, repos) => Object.fromEntries(repos.map(repo => [repo, workspace(id).scopes[0]?.path])),
    launchWorkItem: async (id, ref, choice) => {
      const w = workspace(id);
      const action = 'id' in choice ? w.actions.find(a => a.id === choice.id) : undefined;
      const item = inboxes[id]?.find(i => i.workItem.number === ref.number);
      const seedPrompt = `${ref.repo} #${ref.number}: ${item?.title || 'Sample work item'}\r\n${substitutePlaceholders(action?.prompt || ('customPrompt' in choice ? choice.customPrompt : ''), ref, item)}`;
      const s = createSession(id, { name: item?.title || 'Sample work item', groupId: action?.groupId, scopeId: w.scopes[0].id, workItem: ref, workItemAction: action?.name || 'Custom prompt' });
      prompts.set(s.instanceId, seedPrompt);
      notify('Session started with your saved prompt. Try “fix the retry guard” in the terminal.');
      return { ok: true, session: s, seedPrompt };
    },
    cloneRepo: async (id, repo, destination) => ({ ok: true, path: destination }),
  };
  changes.set('/demo/acme/platform', [{ path: 'src/lib/retry.ts', status: 'modified' }, { path: 'src/lib/retry.test.ts', status: 'untracked' }]);
  window.gitAPI = {
    getStatus: async path => ({ files: structuredClone(changes.get(path) || []), stats: { modifiedCount: changes.get(path)?.length || 0, addedLines: changes.get(path)?.length ? 9 : 0, removedLines: changes.get(path)?.length ? 1 : 0 }, isGitRepo: true, branch: path.includes('.worktrees') ? 'fix/retry-guard' : 'main' }),
    getDiff: async (_path, file, staged) => diff(file, staged),
    stageFile: async (path, file) => { const f = changes.get(path)?.find(f => f.path === file); if (f) f.status = 'staged'; return { success: true }; },
    unstageFile: async (path, file) => { const f = changes.get(path)?.find(f => f.path === file); if (f) f.status = file.endsWith('.test.ts') ? 'untracked' : 'modified'; return { success: true }; },
    commit: async path => { const staged = (changes.get(path) || []).filter(f => f.status === 'staged'); if (!staged.length) return { success: false, error: 'Approve a file to stage it first.' }; changes.set(path, (changes.get(path) || []).filter(f => f.status !== 'staged')); notify('Sample commit created in this demo. No repository was changed.'); return { success: true }; },
    getStagedDiff: async path => ({ stagedFiles: (changes.get(path) || []).filter(f => f.status === 'staged').map(f => f.path), diff: diff('src/lib/retry.ts', true).newContent }),
    generateCommitMessage: async () => ({ message: 'fix: stop retrying non-retryable client errors' }),
  };
  window.fileAPI = {
    readFile: async path => Object.entries(files).find(([name]) => path.endsWith(name))?.[1] || '# Sample file\n',
    listDirectory: async path => {
      const relative = path.replace(/^\/demo\/[^/]+\/[^/]+\/?/, '');
      const children = new Map<string, boolean>();
      for (const name of Object.keys(files)) {
        const prefix = relative ? `${relative}/` : '';
        if (!name.startsWith(prefix)) continue;
        const parts = name.slice(prefix.length).split('/'); children.set(parts[0], parts.length > 1);
      }
      return [...children].map(([name, isDirectory]) => ({ name, path: `${path}/${name}`, isDirectory }));
    },
  };
  window.terminalAPI = {
    create: async options => { if (!transcripts.has(options.instanceId)) transcripts.set(options.instanceId, initialTerminal(options)); return { replay: transcripts.get(options.instanceId)!, exited: false }; },
    sendInput: input, paste: input, resize: () => {}, restart: id => { write(id, '\r\nSession resumed.\r\n❯ '); }, destroy: id => { transcripts.delete(id); inputs.delete(id); }, pathForFile: () => '',
    onData: dataEvents.subscribe, onActivity: noSubscription, onAwaitingConfirmation: noSubscription, onExit: noSubscription, onStatus: noSubscription, getStatusSnapshot: async () => ({}),
  };
  const shellEvents = channel<any>();
  window.shellAPI = {
    attach: async ({ instanceId }) => ({ replay: 'Demo shell · commands are simulated.\r\n$ ', sequence, exited: false, cwd: cwdFor(instanceId) }),
    restart: async options => window.shellAPI.attach(options),
    input: (instanceId, data) => { shellEvents.emit({ instanceId, data: data === '\r' ? '\r\nThis sample shell does not execute commands.\r\n$ ' : data, sequence: ++sequence }); },
    resize: () => {}, onData: shellEvents.subscribe, onExit: noSubscription,
  };
  window.dialogAPI = { selectFolder: async () => { notify('A sample folder is selected. The demo cannot access your files.'); return { name: 'sample-project', path: '/demo/sample/project', isGitRepo: true }; }, selectFolders: async () => [{ name: 'sample-project', path: '/demo/sample/project', isGitRepo: true }] };
  window.conductorAPI = { create: async request => { notify('Sample group created. Automated orchestration is available in the desktop app.'); return window.workspaceAPI.createGroup(request.workspaceId, { name: request.name }); } };
  // Sample repository links are illustrative; do not take visitors to invented PRs.
  document.addEventListener('click', event => {
    const link = (event.target as Element).closest?.('a');
    if (link) { event.preventDefault(); notify('This is a sample repository. GitHub links open the real PR in the desktop app.'); }
  });
}
