import type { WriteBlocks } from '../../../shared/automations';
import { writeBlocks } from './approvalCard';

/**
 * What an entry writes, on an approval card (slice 3-B Task 21): its
 * checkout, each write agent's head in bold with its sentences, each command
 * that runs after a write step, and what passes from the person's
 * environment, as main worded them. Nothing for a view with no `writes`.
 */
export function WritesBlock({ view }: { view: { writes?: WriteBlocks } }) {
  const rows = writeBlocks(view);
  if (rows.length === 0) return null;
  return (
    <div className="automations-approval-writes" role="group" aria-label="What it can change">
      {rows.map((row) =>
        row.kind === 'head' ? (
          <p key={`head:${row.agent}`} className="automations-approval-writes-head">
            <strong>{row.text}</strong>
          </p>
        ) : (
          <p
            key={`${row.kind}:${'agent' in row ? row.agent : ''}:${row.text}`}
            className={`automations-approval-writes-${row.kind}`}
          >
            {row.text}
          </p>
        ),
      )}
    </div>
  );
}
