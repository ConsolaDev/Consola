import { useEffect, useState, type FormEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Play } from 'lucide-react';
import type { ItemTarget, ItemTargetRow, ItemTargets } from '../../../shared/automations';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { lastRunWords } from './presentation';

/**
 * Run on…: runs an automation that takes an item on one a person picks, from
 * its last check, from the Inbox, or by a pasted pull request or issue URL.
 * Opening it lists and starts nothing; choosing a row (or submitting the URL)
 * starts a run and opens it. A refusal is shown here, in the engine's words,
 * and the picker stays open.
 */
export function RunOnPicker({
  workspaceId,
  name,
  disabled,
}: {
  workspaceId: string;
  name: string;
  disabled: boolean;
}) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ItemTargets | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');

  // Once per opening: the lists come from memory and history, so this starts nothing.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setTargets(null);
    setError(null);
    automationsBridge
      .listRunTargets(workspaceId, name)
      .then((listed) => current && setTargets(listed))
      .catch((failure: unknown) => current && setError(ipcErrorMessage(failure)));
    return () => {
      current = false;
    };
  }, [open, workspaceId, name]);

  const start = async (target: ItemTarget) => {
    setStarting(true);
    setError(null);
    try {
      const run = await automationsBridge.runNow(workspaceId, name, target);
      if (run) openPanel({ kind: 'run', runId: run.id });
      setOpen(false);
      setUrl('');
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setStarting(false);
    }
  };

  const submitUrl = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim()) void start({ url: url.trim() });
  };

  const now = new Date();
  const empty = targets && targets.items.length === 0 && targets.inbox.length === 0;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          disabled={disabled}
        >
          <Play size={12} aria-hidden="true" />
          Run on…
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="automations-run-on"
          sideOffset={6}
          align="end"
          aria-label="Run on an item"
        >
          {!targets && !error && <p className="automations-hint">Loading…</p>}
          {targets && (
            <>
              <RunOnSection
                title="In its last check"
                rows={targets.items}
                now={now}
                disabled={starting}
                onPick={start}
              />
              <RunOnSection
                title="In your Inbox"
                rows={targets.inbox}
                now={now}
                disabled={starting}
                onPick={start}
              />
              {empty && !targets.acceptsUrl && (
                <p className="automations-hint">Nothing to run on yet.</p>
              )}
              {targets.acceptsUrl && (
                <form className="automations-run-on-url" onSubmit={submitUrl}>
                  <input
                    type="text"
                    placeholder="Paste a pull request or issue URL"
                    aria-label="Paste a pull request or issue URL"
                    value={url}
                    disabled={starting}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button
                    type="submit"
                    className="dialog-button-secondary automations-small-button"
                    disabled={starting || !url.trim()}
                  >
                    Run
                  </button>
                </form>
              )}
            </>
          )}
          {error && (
            <p className="automations-error" role="alert">
              {error}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function RunOnSection({
  title,
  rows,
  now,
  disabled,
  onPick,
}: {
  title: string;
  rows: ItemTargetRow[];
  now: Date;
  disabled: boolean;
  onPick: (target: ItemTarget) => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="automations-run-on-section" aria-label={title}>
      <h4 className="automations-run-on-title">{title}</h4>
      <ul className="automations-run-on-list">
        {rows.map((row) => (
          <li key={JSON.stringify(row.target)}>
            {/* One it cannot run on stays listed, disabled, saying why. */}
            <button
              type="button"
              className="automations-run-on-row"
              disabled={disabled || row.unavailable !== undefined}
              title={row.unavailable}
              onClick={() => void onPick(row.target)}
            >
              <span className="automations-run-on-label">{row.label}</span>
              <span className="automations-run-on-when">
                {row.unavailable ?? lastRunWords(row.lastRun, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
