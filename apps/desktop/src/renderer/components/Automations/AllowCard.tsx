import { useEffect, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { AutomationView, EntryAgentsView } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { ITEM_TEXT_LINE, skillsLine } from './agentGrantWords';
import { EntrySource } from './AutomationPipeline';
import { allowAgentSections, allowNotes, grantWords } from './checkWords';
import { useIntent } from './parts';

/**
 * What allowing a poll entry lets Consola do, shown before it does it: the
 * check command in full, how often it runs, what the mode then does, the
 * entry as written, and the description, body, servers and skills of each
 * agent its steps run as, so every step is seen exactly as the version Allow
 * accepts has it. A whole server's line names the tools its harness's CLI
 * last listed (main fills them in; nothing is asked to open the card), and
 * an entry whose runs carry an item says, once, that the agent reads text
 * other people wrote with these tools at hand.
 * While the folder does not apply that is the running version, never the
 * live files: Open then says it shows the file as it is now. Allow waits for
 * every agent's body at that version. Allow is for this version of the
 * entry; one that changed since is asked to be reviewed again.
 */
export function AllowCard({
  workspaceId,
  automation,
  opening,
  onOpenFile,
}: {
  workspaceId: string;
  automation: AutomationView;
  opening: boolean;
  onOpenFile: () => void;
}) {
  const { busy, error, act } = useIntent();
  const standing = useAutomationsStore(
    (state) => state.snapshots[workspaceId]?.standing !== undefined,
  );
  const [loaded, setLoaded] = useState<EntryAgentsView | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    automationsBridge.getEntryAgents(workspaceId, automation.name).then(
      (agents) => {
        if (!live) return;
        setLoaded(agents);
        setLoadError(null);
      },
      (failure: unknown) => {
        if (live) setLoadError(ipcErrorMessage(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaceId, automation]);

  const { check, version } = automation;
  if (!check || !version) return null;
  const notes = allowNotes(automation);
  const { ready, readsItems, agents } = allowAgentSections(automation, loaded, standing);
  return (
    <section className="automations-allow-card" aria-label={`Allow ${automation.name}`}>
      <div className="automations-allow-body">
        <p className="automations-allow-label">Check command</p>
        <pre className="automations-allow-command">
          <code>{check.command}</code>
        </pre>
        <p className="automations-allow-line">
          <strong>Every {check.every}.</strong> {grantWords(automation.mode)}
        </p>
        {notes.map((note) => (
          <p key={note} className="automations-allow-line automations-allow-note">
            {note}
          </p>
        ))}
      </div>
      <EntrySource
        workspaceId={workspaceId}
        automation={automation}
        opening={opening}
        onOpenFile={onOpenFile}
      />
      {agents.length > 0 && (
        <ul className="automations-allow-agents" aria-label="Agent files">
          {agents.map((agent) => (
            <li key={agent.file} className="automations-allow-agent">
              <div className="automations-allow-line">
                {agent.text}
                <button
                  type="button"
                  className="dialog-button-secondary automations-small-button"
                  aria-label={`${agent.openLabel}: ${agent.file}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`open:${agent.file}`, () =>
                      automationsBridge.openFile(workspaceId, agent.file),
                    )
                  }
                >
                  <ExternalLink size={12} aria-hidden="true" />
                  {agent.openLabel}
                </button>
              </div>
              {agent.body === undefined ? (
                <p className="automations-hint">{loadError ?? 'Loading…'}</p>
              ) : (
                <>
                  {agent.note && (
                    <p className="automations-hint automations-entry-note" role="note">
                      {agent.note}
                    </p>
                  )}
                  {agent.description !== undefined && (
                    <p className="automations-approval-description">{agent.description}</p>
                  )}
                  <details className="automations-details automations-allow-agent-body">
                    <summary>{agent.file}</summary>
                    <pre className="automations-prompt">{agent.body}</pre>
                  </details>
                  {agent.servers?.map((line) => (
                    <p key={line} className="automations-allow-line">
                      {line}
                    </p>
                  ))}
                  {agent.skills && (
                    <div className="automations-allow-line">
                      {skillsLine(agent.skills)}
                      {agent.skills.map((skill) => {
                        const file = `skills/${skill}/SKILL.md`;
                        return (
                          <button
                            key={skill}
                            type="button"
                            className="dialog-button-secondary automations-small-button"
                            aria-label={`${agent.openLabel} ${file}`}
                            disabled={busy !== null}
                            onClick={() =>
                              void act(`open:${file}`, () =>
                                automationsBridge.openFile(workspaceId, file),
                              )
                            }
                          >
                            <ExternalLink size={12} aria-hidden="true" />
                            {agent.openLabel}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {readsItems && agents.length > 0 && (
        <p className="automations-allow-line automations-allow-note">{ITEM_TEXT_LINE}</p>
      )}
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}
      <div className="automations-allow-actions">
        <button
          type="button"
          className="dialog-button-primary automations-small-button"
          disabled={busy !== null || !ready}
          onClick={() =>
            void act('allow', () => automationsBridge.allow(workspaceId, automation.name, version))
          }
        >
          <ShieldCheck size={12} aria-hidden="true" />
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </button>
      </div>
    </section>
  );
}
