import { KeyRound } from 'lucide-react';
import type { SecretBindingView } from '../../../shared/automations';
import { useAutomationsStore } from '../../stores/automationsStore';
import { needsBinding, secretCardLines, secretPlacesOf, type SecretPlace } from './secretWords';

/**
 * An entry's secrets as the workspace's snapshot holds them (review S1): its
 * places, built from the uses main resolved, and whether any of their names
 * is unbound, which turns a card's Start or Allow into Bind….
 */
export function useEntrySecrets(
  workspaceId: string,
  automation: string,
): {
  secrets: SecretBindingView[] | undefined;
  places: SecretPlace[];
  unbound: boolean;
} {
  const secrets = useAutomationsStore((state) => state.snapshots[workspaceId]?.secrets);
  const places = secretPlacesOf(automation, secrets);
  return { secrets, places, unbound: needsBinding(places, secrets) };
}

/**
 * A card's Secrets lines: where each name goes and where this Mac binds it,
 * every other automation it goes to, and the trust line. Nothing when the
 * entry names no secret. Never a value: the snapshot holds none.
 */
export function SecretLines({
  workspaceId,
  automation,
  lineClassName = 'automations-allow-line',
}: {
  workspaceId: string;
  automation: string;
  lineClassName?: string;
}) {
  const { secrets, places } = useEntrySecrets(workspaceId, automation);
  const lines = secretCardLines({ automation, places, secrets, at: {} });
  if (lines.length === 0) return null;
  return (
    <section className="automations-secret-lines" aria-label="Secrets">
      <p className="automations-allow-label automations-secret-head">
        <KeyRound size={12} aria-hidden="true" />
        Secrets
      </p>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are rebuilt whole; a name's line and its "also" lines can read alike.
        <p key={`${index}:${line}`} className={lineClassName}>
          {line}
        </p>
      ))}
    </section>
  );
}
