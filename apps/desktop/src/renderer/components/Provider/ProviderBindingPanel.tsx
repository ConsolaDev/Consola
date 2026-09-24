import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, RefreshCw } from 'lucide-react';
import { PROVIDER_META, type ProviderProbeResult } from '../../../shared/providers';
import type { Workspace } from '../../../shared/workspace';
import { providerBridge } from '../../services/providerBridge';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

interface ProviderBindingPanelProps {
  workspace: Workspace;
  onConnected?: () => void;
}

const PROVIDER = PROVIDER_META.github;
const LOGIN_COMMAND = 'gh auth login --hostname github.com --web';

/** Shared by Inbox onboarding and settings. Credentials stay with the gh CLI. */
export function ProviderBindingPanel({ workspace, onConnected }: ProviderBindingPanelProps) {
  const setProviderBinding = useWorkspaceStore((state) => state.setProviderBinding);
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
  const [org, setOrg] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const probeRequest = useRef(0);

  const runProbe = useCallback(async () => {
    const request = ++probeRequest.current;
    setIsChecking(true);
    setProbeError(null);
    try {
      const result = await providerBridge.probe(PROVIDER.id);
      if (request === probeRequest.current) setProbe(result);
    } catch (error) {
      if (request === probeRequest.current) {
        setProbe(null);
        setProbeError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (request === probeRequest.current) setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void runProbe();
    return () => { ++probeRequest.current; };
  }, [runProbe]);

  useEffect(() => {
    setSelectedLogin(workspace.provider?.accountLogin ?? null);
    setOrg(workspace.provider?.org ?? '');
    setSaveError(null);
  }, [workspace.id, workspace.provider?.accountLogin, workspace.provider?.org]);

  const bound = workspace.provider;
  const available = !!probe?.available;
  const accounts = available ? probe.accounts : [];
  const selectedAccountExists = accounts.some(account => account.login === selectedLogin);
  const boundAccountMissing = !!bound && available && !accounts.some(account => account.login === bound.accountLogin);
  const isDirty = selectedLogin !== (bound?.accountLogin ?? null) || org.trim() !== (bound?.org ?? '');

  const handleSave = async () => {
    if (!selectedLogin || !selectedAccountExists || isChecking || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await setProviderBinding(workspace.id, {
        id: PROVIDER.id,
        accountLogin: selectedLogin,
        org: org.trim() || undefined,
      });
      onConnected?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnbind = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await setProviderBinding(workspace.id, null);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">
          {PROVIDER.displayName}
          {bound && <span className="github-bound-tag">Connected as {bound.accountLogin}</span>}
        </h3>
        <button type="button" className="github-recheck-button" onClick={() => void runProbe()}
          disabled={isChecking || isSaving} aria-label="Re-check gh">
          {isChecking
            ? <Loader2 className="github-setup-spinner" size={14} aria-hidden="true" />
            : <RefreshCw size={14} aria-hidden="true" />}
          {isChecking ? 'Checking…' : 'Re-check setup'}
        </button>
      </div>
      <p className="github-section-description">
        Bring your pull requests and assigned issues into Inbox. Connect a GitHub account to {workspace.name};
        Consola uses that account for this workspace without switching your other workspaces.
      </p>
      {/* An unknown probe is not a missing CLI. Keep the instructions off
          screen until the first check finishes; re-checks retain the form. */}
      {isChecking && probe === null && (
        <div className="github-setup-loading" role="status">
          <Loader2 className="github-setup-spinner" size={20} aria-hidden="true" />
          <span>Checking the GitHub CLI and signed-in accounts…</span>
        </div>
      )}
      {probeError && <p className="github-section-error" role="alert">Could not check GitHub setup: {probeError} Try Re-check setup.</p>}
      {!isChecking && probe?.error && <p className="github-section-error" role="status">{probe.error}</p>}

      {probe !== null && <ol className="github-setup-steps" aria-busy={isChecking}>
        <li className="github-setup-step">
          <h4 className="github-setup-step-title">Install the GitHub CLI {available && <Check size={14} aria-label="Installed" />}</h4>
          {available ? <p className="github-section-description">gh {probe.version ?? ''} is installed.</p> : <>
            <p>Open your terminal. On macOS with Homebrew, run:</p>
            <code className="github-setup-command">brew install gh</code>
            <p>Without Homebrew, use the <a href="https://cli.github.com/" target="_blank" rel="noreferrer">GitHub CLI installation instructions</a>.</p>
            <p>Then run <code>gh --version</code> to confirm it is available.</p>
          </>}
        </li>
        <li className="github-setup-step">
          <h4 className="github-setup-step-title">Sign in to GitHub {accounts.length > 0 && <Check size={14} aria-label="Signed in" />}</h4>
          {accounts.length > 0 && !boundAccountMissing ? <p className="github-section-description">Signed in as {accounts.map(account => account.login).join(', ')}.</p> : <>
            {boundAccountMissing && <p className="github-section-error">The connected account {bound!.accountLogin} is no longer signed in. Sign in again or choose another account below.</p>}
            <p>Run this in your terminal:</p>
            <code className="github-setup-command">{LOGIN_COMMAND}</code>
            <p>Follow the prompts, copy the one-time code when shown, and finish signing in in your browser.</p>
            <p>Run <code>gh auth status --hostname github.com</code> to verify your account, then select <strong>Re-check setup</strong> above.</p>
          </>}
        </li>
        <li className="github-setup-step">
          <h4 className="github-setup-step-title">Connect this workspace {bound && !boundAccountMissing && available && <Check size={14} aria-label="Connected" />}</h4>
          <p>Choose an account below, optionally limit Inbox to an organization, then select <strong>{bound ? 'Update binding' : 'Connect GitHub'}</strong>.</p>
          {accounts.length === 0 ? <p className="github-section-description">Your accounts will appear here after you sign in and re-check setup.</p> : <>
            <div className="ws-choice-list" role="radiogroup" aria-label="GitHub account">
              {accounts.map(account => (
                <button key={account.login} type="button" role="radio" aria-checked={selectedLogin === account.login}
                  disabled={isSaving || isChecking}
                  className={`ws-choice-row ${selectedLogin === account.login ? 'selected' : ''}`}
                  onClick={() => setSelectedLogin(account.login)}>
                  <span className="ws-choice-name">{account.login}</span>
                  {account.active && <span className="github-account-hint">gh’s active account</span>}
                  {selectedLogin === account.login && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <label className="github-org-field">
              <span>Organization (optional — narrows the Inbox)</span>
              <input type="text" value={org} onChange={event => setOrg(event.target.value)}
                placeholder="e.g. sympower" spellCheck={false} disabled={isSaving} />
            </label>
            <p className="github-section-description">Leave this empty to include all repositories this account can access.</p>
            <div className="github-section-actions">
              <button type="button" className="dialog-button-primary" onClick={() => void handleSave()}
                disabled={!selectedAccountExists || !isDirty || isSaving || isChecking}>
                {isSaving ? 'Saving…' : bound ? 'Update binding' : 'Connect GitHub'}
              </button>
            </div>
          </>}
        </li>
      </ol>}
      {saveError && <p className="github-section-error" role="alert">Could not save GitHub connection: {saveError}</p>}
      {bound && <div className="github-section-actions"><button type="button" className="github-unbind-button"
        onClick={() => void handleUnbind()} disabled={isSaving || isChecking}>Unbind</button></div>}
      {probe !== null && <p className="github-section-footnote">
        Consola stores no GitHub credentials; the gh CLI manages sign-in. Account changes apply when a session’s terminal next starts.
      </p>}
    </>
  );
}
