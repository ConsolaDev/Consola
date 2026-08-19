import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import type { HarnessDriverId } from '../../../shared/types';
import { HARNESS_DRIVERS } from '../../../shared/constants';
import {
  DEFAULT_ACCENT_COLOR,
  HARNESS_ID_PATTERN,
  parseLaunchArgs,
  useHarnessStore,
} from '../../stores/harnessStore';
import { ConfigFields, IdentityFields, type HarnessDraft } from './harnessFields';
import './styles.css';

const STEPS = ['Driver', 'Identity', 'Config'] as const;

function emptyDraft(): HarnessDraft {
  return {
    id: '',
    driverId: 'claude',
    name: '',
    accentColor: DEFAULT_ACCENT_COLOR,
    binaryPath: '',
    configDir: '',
    launchArgs: '',
  };
}

/** Turn a name into a usable routing key, so the ID rarely needs typing. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function AddHarnessWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<HarnessDraft>(emptyDraft);
  const [idTouched, setIdTouched] = useState(false);

  const harnesses = useHarnessStore((state) => state.harnesses);
  const addHarness = useHarnessStore((state) => state.addHarness);
  const probeHarness = useHarnessStore((state) => state.probeHarness);

  const reset = () => {
    setStep(0);
    setDraft(emptyDraft());
    setIdTouched(false);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const change = (updates: Partial<HarnessDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...updates };
      if ('id' in updates) setIdTouched(true);
      // Keep the ID in step with the name until it is edited directly.
      if ('name' in updates && !idTouched) next.id = slugify(updates.name ?? '');
      return next;
    });
  };

  const idError = (() => {
    if (!draft.id) return 'An instance ID is required.';
    if (!HARNESS_ID_PATTERN.test(draft.id))
      return "Use only letters, digits, '-', or '_'.";
    if (harnesses.some((harness) => harness.id === draft.id))
      return 'That instance ID is already in use.';
    return undefined;
  })();

  const canAdvance = step === 0 ? true : step === 1 ? !idError && !!draft.name.trim() : true;

  const submit = async () => {
    if (idError || !draft.name.trim()) return;
    const harness = await addHarness({
      id: draft.id,
      driverId: draft.driverId,
      name: draft.name.trim(),
      accentColor: draft.accentColor,
      binaryPath: draft.binaryPath.trim() || undefined,
      configDir: draft.configDir.trim() || undefined,
      extraArgs: parseLaunchArgs(draft.launchArgs),
    });
    void probeHarness(harness.id);
    close();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content harness-wizard">
          <Dialog.Title className="dialog-title">Add harness</Dialog.Title>
          <Dialog.Description className="harness-wizard-description">
            Point Consola at another agent CLI installation — a second login, a
            different binary, or its own configuration.
          </Dialog.Description>

          <ol className="harness-wizard-steps">
            {STEPS.map((label, index) => (
              <li
                key={label}
                className={`harness-wizard-step ${index === step ? 'active' : ''} ${
                  index < step ? 'complete' : ''
                }`}
              >
                <span className="harness-wizard-step-marker">
                  {index < step ? <Check size={12} /> : index + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>

          <div className="harness-wizard-body">
            {step === 0 && (
              <div className="harness-driver-list">
                {HARNESS_DRIVERS.map((driver) => (
                  <button
                    key={driver.id}
                    type="button"
                    className={`harness-driver-option ${
                      draft.driverId === driver.id ? 'selected' : ''
                    }`}
                    disabled={!driver.available}
                    onClick={() => change({ driverId: driver.id as HarnessDriverId })}
                  >
                    <span className="harness-driver-option-label">
                      {driver.label}
                      {!driver.available && (
                        <span className="harness-driver-badge">Coming soon</span>
                      )}
                    </span>
                    <span className="harness-field-hint">{driver.description}</span>
                  </button>
                ))}
              </div>
            )}

            {step === 1 && (
              <IdentityFields
                draft={draft}
                onChange={change}
                idEditable
                idError={draft.id ? idError : undefined}
              />
            )}

            {step === 2 && <ConfigFields draft={draft} onChange={change} />}
          </div>

          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button-secondary"
              onClick={() => (step === 0 ? close() : setStep(step - 1))}
            >
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                className="dialog-button-primary"
                disabled={!canAdvance}
                onClick={() => setStep(step + 1)}
              >
                Next
              </button>
            ) : (
              <button type="button" className="dialog-button-primary" onClick={submit}>
                Add harness
              </button>
            )}
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
