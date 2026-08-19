import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import {
  formatLaunchArgs,
  parseLaunchArgs,
  useHarnessStore,
  type Harness,
} from '../../stores/harnessStore';
import { ConfigFields, IdentityFields, type HarnessDraft } from './harnessFields';
import './styles.css';

function toDraft(harness: Harness): HarnessDraft {
  return {
    id: harness.id,
    driverId: harness.driverId,
    name: harness.name,
    accentColor: harness.accentColor,
    binaryPath: harness.binaryPath ?? '',
    configDir: harness.configDir ?? '',
    launchArgs: formatLaunchArgs(harness.extraArgs),
  };
}

/**
 * Edit an existing harness.
 *
 * Uses the same field groups as the add wizard, without its step chrome: the
 * ID and driver are fixed after creation, so there is nothing to walk through.
 */
export function EditHarnessDialog({
  harness,
  onClose,
}: {
  harness: Harness | null;
  onClose: () => void;
}) {
  const updateHarness = useHarnessStore((state) => state.updateHarness);
  const probeHarness = useHarnessStore((state) => state.probeHarness);
  const [draft, setDraft] = useState<HarnessDraft | null>(null);

  // Load the harness into a draft the first time this render cycle sees it.
  const activeDraft = draft?.id === harness?.id ? draft : harness ? toDraft(harness) : null;

  const change = (updates: Partial<HarnessDraft>) => {
    if (!activeDraft) return;
    setDraft({ ...activeDraft, ...updates });
  };

  const save = async () => {
    if (!harness || !activeDraft || !activeDraft.name.trim()) return;
    // Awaited so the probe that follows reads the harness main just wrote,
    // not the pre-edit binary path or config directory.
    await updateHarness(harness.id, {
      name: activeDraft.name.trim(),
      accentColor: activeDraft.accentColor,
      binaryPath: activeDraft.binaryPath.trim() || undefined,
      configDir: activeDraft.configDir.trim() || undefined,
      extraArgs: parseLaunchArgs(activeDraft.launchArgs),
    });
    void probeHarness(harness.id);
    setDraft(null);
    onClose();
  };

  const cancel = () => {
    setDraft(null);
    onClose();
  };

  return (
    <Dialog.Root open={harness !== null} onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content harness-wizard">
          <Dialog.Title className="dialog-title">Edit harness</Dialog.Title>

          {activeDraft && (
            <div className="harness-wizard-body">
              <IdentityFields draft={activeDraft} onChange={change} idEditable={false} />
              <ConfigFields draft={activeDraft} onChange={change} />
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" className="dialog-button-secondary" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button-primary"
              disabled={!activeDraft?.name.trim()}
              onClick={save}
            >
              Save changes
            </button>
          </div>

          <Dialog.Close asChild>
            <button className="dialog-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
