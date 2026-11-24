import { Plug } from 'lucide-react';
import type { CallView } from '../../../shared/automations';
import { callCardLines, serverLines, serversOf } from './callWords';

/**
 * A call's lines on a card: its ref, each argument as written with where its
 * value comes from and its trust, its outputs, whether it also runs in a dry
 * run, and a destructive Consola tool's note. Never a value: a card is read
 * before any exists.
 */
export function CallLines({
  call,
  outputs,
  lineClassName = 'automations-approval-description',
}: {
  call: CallView;
  outputs: readonly string[];
  lineClassName?: string;
}) {
  return (
    <div className="automations-call-lines">
      {callCardLines(call, outputs).map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are rebuilt whole and two can read alike.
        <p key={`${index}:${line}`} className={lineClassName}>
          {line}
        </p>
      ))}
    </div>
  );
}

/**
 * The factory servers a card's calls use, each once in step order: what
 * each starts or calls, as the person, with what, and its notes. From the
 * calls' own facts (`CallView.facts`), so a card shows exactly the
 * definition it accepts.
 */
export function ServerLines({
  calls,
  lineClassName = 'automations-approval-description',
}: {
  calls: readonly CallView[];
  lineClassName?: string;
}) {
  const servers = serversOf(calls);
  if (servers.length === 0) return null;
  return (
    <section className="automations-server-lines" aria-label="Servers">
      <p className="automations-allow-label automations-secret-head">
        <Plug size={12} aria-hidden="true" />
        Servers
      </p>
      {servers.map((facts) => (
        <div key={facts.name} className="automations-server-card-entry">
          <p className={lineClassName}>
            <code>{facts.name}</code>
            {facts.description !== undefined ? ` · ${facts.description}` : ''}
          </p>
          {serverLines(facts).map((line) => (
            <p key={line} className={lineClassName}>
              {line}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}
