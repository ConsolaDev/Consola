import { useEffect, useId, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { BrowserAuthRequestMessage } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import '../Dialogs/styles.css';

/**
 * The sign-in a page asks for (HTTP basic auth). Main decides which requests
 * are worth asking about (only the page's own origin) and holds the page
 * waiting; this only asks the person and sends the answer back by request id.
 *
 * Requests queue, one dialog at a time. Closing the dialog any way but
 * "Sign in" cancels the request, and main cancels it too when it times out or
 * its page goes away (`BROWSER_AUTH_CANCELLED`), so a dialog never outlives
 * the page that asked. The typed password is state of this component only: it
 * is sent once, never stored or logged, and gone with the dialog.
 */
export function BrowserAuthDialog() {
  const [queue, setQueue] = useState<BrowserAuthRequestMessage[]>([]);

  useEffect(() => {
    const offRequest = browserBridge.onAuthRequest((request) =>
      setQueue((previous) => [...previous, request]),
    );
    const offCancelled = browserBridge.onAuthCancelled(({ id }) =>
      setQueue((previous) => previous.filter((request) => request.id !== id)),
    );
    return () => {
      offRequest();
      offCancelled();
    };
  }, []);

  const request = queue[0];
  if (!request) return null;

  const done = () => setQueue((previous) => previous.filter((r) => r.id !== request.id));
  return (
    <SignInForm
      key={request.id}
      request={request}
      onAnswer={(credentials) => {
        browserBridge
          .answerAuth(request.id, credentials)
          .catch((error: unknown) => console.warn('In-app browser sign-in failed:', error));
        done();
      }}
    />
  );
}

interface SignInFormProps {
  request: BrowserAuthRequestMessage;
  onAnswer: (credentials: { username: string; password: string } | null) => void;
}

function SignInForm({ request, onAnswer }: SignInFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const userId = useId();
  const passwordId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onAnswer({ username, password });
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onAnswer(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <form onSubmit={submit} autoComplete="off">
            <Dialog.Title className="dialog-title">Sign in to {request.origin}</Dialog.Title>
            <p className="dialog-description">
              This site asks for a username and password.
              {request.realm ? ` It calls the area "${request.realm}".` : ''} Only enter them if you
              trust it.
            </p>
            <div className="dialog-field">
              <label className="dialog-label" htmlFor={userId}>
                Username
              </label>
              <input
                id={userId}
                className="dialog-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-label" htmlFor={passwordId}>
                Password
              </label>
              <input
                id={passwordId}
                className="dialog-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="dialog-button-secondary"
                onClick={() => onAnswer(null)}
              >
                Cancel
              </button>
              <button type="submit" className="dialog-button-primary">
                Sign in
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
