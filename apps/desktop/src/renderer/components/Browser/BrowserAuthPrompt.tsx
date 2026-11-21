import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { BrowserAuthRequestMessage } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { dropAuthRequest } from '../../stores/browserAuthStore';

interface BrowserAuthPromptProps {
  request: BrowserAuthRequestMessage;
}

/**
 * The sign-in a page asks for (HTTP basic auth), drawn over that page like an
 * error, in its tab only and only while the tab is shown. It is not a dialog:
 * it never takes the keyboard. Focus moves into it when the person clicks a
 * field, so keys meant for the terminal or the address bar cannot land in it.
 *
 * Main decides which requests exist (a visible navigation to the page's own
 * origin) and cancels one that times out or whose page moves on. The typed
 * password is state of this component only: sent once, never stored or logged.
 */
export function BrowserAuthPrompt({ request }: BrowserAuthPromptProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const userId = useId();
  const passwordId = useId();

  const answer = (credentials: { username: string; password: string } | null) => {
    browserBridge
      .answerAuth(request.id, credentials)
      .catch((error: unknown) => console.warn('In-app browser sign-in failed:', error));
    dropAuthRequest(request.id);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (username === '') return;
    answer({ username, password });
  };
  // Only keys typed in the form reach this, so Escape never closes anything else.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') answer(null);
  };

  return (
    <div className="browser-auth" data-testid="browser-auth">
      <form
        className="browser-auth-card"
        onSubmit={submit}
        onKeyDown={onKeyDown}
        autoComplete="off"
      >
        <h3 className="browser-auth-title">Sign in to {request.origin}</h3>
        <p className="browser-auth-hint">
          This site asks for a username and password.
          {request.realm ? ` It calls the area "${request.realm}".` : ''} Only enter them if you
          trust it.
        </p>
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
        />
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
        <div className="browser-error-actions">
          <button type="button" className="dialog-button-secondary" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="dialog-button-primary" disabled={username === ''}>
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
