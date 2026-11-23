import { useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy } from 'lucide-react';
import type { SecretReferenceInput } from '../../../shared/secrets';
import { secretsBridge } from '../../services/secretsBridge';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import {
  KEYCHAIN_COMMAND_WORDS,
  defaultKeychainService,
  keychainCommand,
  referencePreview,
} from './secretsWords';
import '../Dialogs/styles.css';

type Kind = SecretReferenceInput['kind'];

const KINDS: Array<{ kind: Kind; label: string }> = [
  { kind: 'keychain', label: 'Keychain' },
  { kind: '1password', label: '1Password' },
  { kind: 'env', label: 'Environment variable' },
];

/**
 * Binds one name to where its value lives on this Mac: a keychain item, a
 * 1Password field or a login-environment variable. It asks where, never what:
 * no field here takes a value (there is no paste field), and the keychain's
 * Terminal command lets `security` ask for one so it never passes through
 * Consola. Main builds and checks the reference and says why one is refused.
 */
export function BindSecretDialog({
  workspaceId,
  name,
  onClose,
  onBound,
}: {
  workspaceId: string;
  name: string;
  onClose: () => void;
  onBound: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<Kind>('keychain');
  const [service, setService] = useState(() => defaultKeychainService(workspaceId));
  const [account, setAccount] = useState(name);
  const [reference, setReference] = useState('');
  const [variable, setVariable] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = keychainCommand(workspaceId, name);

  // Surrounding spaces are a paste's, never a reference's: main checks the rest.
  const input: SecretReferenceInput =
    kind === 'keychain'
      ? { kind, service: service.trim(), account: account.trim() }
      : kind === '1password'
        ? { kind, reference: reference.trim() }
        : { kind, name: variable.trim() };
  const complete =
    input.kind === 'keychain'
      ? input.service !== '' && input.account !== ''
      : input.kind === '1password'
        ? input.reference !== ''
        : input.name !== '';

  const bind = async () => {
    if (!complete || binding) return;
    setError(null);
    setBinding(true);
    try {
      await secretsBridge.bind(workspaceId, name, input);
      onBound();
      onClose();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBinding(false);
    }
  };

  const copy = () =>
    void navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => setCopied(false),
    );

  const field = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    placeholder?: string,
  ) => {
    const fieldId = `${id}-${label}`;
    return (
      <div className="dialog-field">
        <label className="dialog-label" htmlFor={fieldId}>
          {label}
        </label>
        <input
          id={fieldId}
          className="dialog-input ws-secret-input"
          value={value}
          placeholder={placeholder}
          disabled={binding}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void bind();
          }}
        />
      </div>
    );
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content ws-secret-dialog">
          <Dialog.Title className="dialog-title">Bind {name}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Where this Mac keeps {name}'s value. Consola stores where, never the value.
          </Dialog.Description>
          <div className="dialog-form">
            <fieldset className="ws-secret-kinds">
              <legend className="dialog-label">Where it lives</legend>
              {KINDS.map((option) => (
                <label key={option.kind} className="ws-secret-kind">
                  <input
                    type="radio"
                    name={`${id}-kind`}
                    value={option.kind}
                    checked={kind === option.kind}
                    disabled={binding}
                    onChange={() => {
                      setKind(option.kind);
                      setError(null);
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
            {kind === 'keychain' && (
              <>
                {field('Service', service, setService)}
                {field('Account', account, setAccount)}
                <div className="ws-secret-command">
                  <p className="ws-panel-hint">{KEYCHAIN_COMMAND_WORDS}</p>
                  <div className="ws-secret-command-row">
                    <code className="ws-secret-command-text">{command}</code>
                    <button
                      type="button"
                      className="dialog-button-secondary ws-panel-action"
                      onClick={copy}
                    >
                      <Copy size={12} aria-hidden="true" />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              </>
            )}
            {kind === '1password' &&
              field('Reference', reference, setReference, 'op://<vault>/<item>/<field>')}
            {kind === 'env' && field('Variable', variable, setVariable)}
            <p className="ws-panel-hint">
              Binds to <code>{referencePreview(input)}</code>
            </p>
            {error && (
              <span className="dialog-error" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button-secondary"
              onClick={onClose}
              disabled={binding}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void bind()}
              disabled={!complete || binding}
            >
              {binding ? 'Binding…' : 'Bind'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
