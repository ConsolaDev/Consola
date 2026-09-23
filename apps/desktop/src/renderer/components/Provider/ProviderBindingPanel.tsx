import { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { PROVIDER_META, type ProviderProbeResult } from '../../../shared/providers';
import type { Workspace } from '../../../shared/workspace';
import { providerBridge } from '../../services/providerBridge';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import './styles.css';

interface ProviderBindingPanelProps {
  workspace: Workspace;
}

/**
 * The one place in the renderer that names a provider: GitHub is the only
 * one there is, and the binding panel is where a workspace picks it. Every
 * other component reads `workspace.provider.id` and PROVIDER_META.
 */
const PROVIDER = PROVIDER_META.github;

/**
 * Bind a workspace to one keyring account of the provider's CLI. Mounted
 * inside the Workspace settings section, which supplies the workspace and
 * the panel chrome.
 *
 * Consola stores zero provider credentials. The CLI is the broker: this
 * panel only learns which accounts exist (via a main-process probe) and
 * records a login name on the workspace. Tokens are borrowed main-side at
 * spawn time and never reach this component.
 */
export function ProviderBindingPanel({ workspace }: ProviderBindingPanelProps) {
  const setProviderBinding = useWorkspaceStore((state) => state.setProviderBinding);

  const [probe, setProbe] = useState<ProviderProbeResult | null>(null);
  const [selectedLogin, setSelectedLogin] = useState<string | null>(null);
  const [org, setOrg] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Availability is a live fact about the machine, so check when the section
  // is opened rather than polling in the background — same as harness health.
  const runProbe = useCallback(() => {
    setProbe(null);
    void providerBridge.probe(PROVIDER.id).then(setProbe);
  }, []);

  useEffect(() => {
    runProbe();
  }, [runProbe]);

  // Follow the workspace's stored binding whenever the workspace changes.
  useEffect(() => {
    setSelectedLogin(workspace.provider?.accountLogin ?? null);
    setOrg(workspace.provider?.org ?? '');
  }, [workspace.id, workspace.provider?.accountLogin, workspace.provider?.org]);

  const handleSave = async () => {
    // Belt and suspenders: selectedLogin can only ever be set from an
    // account.login the probe actually returned (see the radio group below),
    // never free text, but the guard stays here too since this is the one
    // place that can reach the IPC boundary. A binding with a missing or
    // empty accountLogin must never be constructible, let alone sent — main
    // coerces it with String(...) and would otherwise persist "undefined".
    if (!selectedLogin) return;
    setIsSaving(true);
    try {
      await setProviderBinding(workspace.id, {
        id: PROVIDER.id,
        accountLogin: selectedLogin,
        org: org.trim() || undefined,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnbind = async () => {
    setIsSaving(true);
    try {
      await setProviderBinding(workspace.id, null);
    } finally {
      setIsSaving(false);
    }
  };

  const bound = workspace.provider;
  const isDirty =
    selectedLogin !== (bound?.accountLogin ?? null) || org.trim() !== (bound?.org ?? '');

  return (
    <>
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">
          {PROVIDER.displayName}
          {bound && <span className="github-bound-tag">bound: {bound.accountLogin}</span>}
        </h3>
        <button
          type="button"
          className="github-icon-button"
          onClick={runProbe}
          aria-label={`Re-check ${PROVIDER.cliName}`}
          title={`Re-check ${PROVIDER.cliName}`}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <p className="github-section-description">
        Bind this workspace to one <code>{PROVIDER.cliName}</code> account and every session in
        it runs <code>{PROVIDER.cliName}</code> as that account — no global account switching.
        Consola stores no credentials; the <code>{PROVIDER.cliName}</code> CLI holds them.
      </p>

      {probe === null && (
        <p className="github-section-status">Checking for the {PROVIDER.cliName} CLI…</p>
      )}

      {probe !== null && !probe.available && (
        <div className="github-empty-state">
          <p>
            {PROVIDER.displayName} features need the <code>{PROVIDER.cliName}</code> CLI, which
            was not found.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Install it with <code>{PROVIDER.installHint}</code>, sign in with{' '}
            <code>{PROVIDER.loginHint}</code>, then re-check. Everything else in Consola works
            without it.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length === 0 && (
        <div className="github-empty-state">
          <p>
            <code>{PROVIDER.cliName}</code> {probe.version ? `${probe.version} ` : ''}is
            installed, but no accounts are signed in.
          </p>
          {probe.error && <p className="github-section-error">{probe.error}</p>}
          <p>
            Run <code>{PROVIDER.loginHint}</code> in a terminal (once per account), then
            re-check.
          </p>
        </div>
      )}

      {probe !== null && probe.available && probe.accounts.length > 0 && (
        <>
          <div
            className="ws-choice-list"
            role="radiogroup"
            aria-label={`${PROVIDER.displayName} account`}
          >
            {probe.accounts.map((account) => (
              <button
                key={account.login}
                type="button"
                role="radio"
                aria-checked={selectedLogin === account.login}
                className={`ws-choice-row ${
                  selectedLogin === account.login ? 'selected' : ''
                }`}
                onClick={() => setSelectedLogin(account.login)}
              >
                <span className="ws-choice-name">{account.login}</span>
                {account.active && (
                  <span className="github-account-hint">{PROVIDER.cliName}’s active account</span>
                )}
                {selectedLogin === account.login && <Check size={14} />}
              </button>
            ))}
          </div>

          <label className="github-org-field">
            <span>Organization (optional — narrows the Inbox)</span>
            <input
              type="text"
              value={org}
              onChange={(event) => setOrg(event.target.value)}
              placeholder="e.g. sympower"
              spellCheck={false}
            />
          </label>

          <div className="github-section-actions">
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void handleSave()}
              disabled={!selectedLogin || !isDirty || isSaving}
            >
              {bound ? 'Update binding' : 'Bind account'}
            </button>
            {bound && (
              <button
                type="button"
                className="github-unbind-button"
                onClick={() => void handleUnbind()}
                disabled={isSaving}
              >
                Unbind
              </button>
            )}
          </div>
          <p className="github-section-footnote">
            Applies to sessions the next time their terminal starts. Already-running
            terminals keep the environment they launched with.
          </p>
        </>
      )}
    </>
  );
}
