import { ExternalLink, ShieldCheck } from 'lucide-react';
import type { AutomationView } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { EntrySource } from './AutomationPipeline';
import { allowAgentLines, allowNotes, grantWords } from './checkWords';
import { useIntent } from './parts';

/**
 * What allowing a poll entry lets Consola do, shown before it does it: the
 * check command in full, how often it runs, what the mode then does, and the
 * entry as written, so every step is seen exactly as the file has it, and
 * each agent file its steps run as, to open and read. Allow is for this
 * version of the entry; one that changed since is asked to be reviewed again.
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
  const { check, version } = automation;
  if (!check || !version) return null;
  const notes = allowNotes(automation);
  const agentFiles = allowAgentLines(automation);
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
      {agentFiles.length > 0 && (
        <ul className="automations-allow-agents" aria-label="Agent files">
          {agentFiles.map(({ file, text }) => (
            <li key={file} className="automations-allow-line">
              {text}
              <button
                type="button"
                className="dialog-button-secondary automations-small-button"
                aria-label={`Open ${file}`}
                disabled={busy !== null}
                onClick={() =>
                  void act(`open:${file}`, () => automationsBridge.openFile(workspaceId, file))
                }
              >
                <ExternalLink size={12} aria-hidden="true" />
                Open
              </button>
            </li>
          ))}
        </ul>
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
          disabled={busy !== null}
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
