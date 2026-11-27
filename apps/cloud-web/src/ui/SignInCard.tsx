import { useState } from 'react';
import { signInWithGoogle } from '../services/authClient';
import { BrandMark } from './BrandMark';

/**
 * The sign-in card: Continue with Google. A page that needs a person signed in first (a one-time
 * link) gives its own title and line, and the path sign-in comes back to (`returnTo`).
 */
export function SignInCard({
  error,
  title = 'Sign in to Consola Cloud',
  hint = 'Open your workspaces, or create your first one.',
  returnTo,
}: {
  error: string | null;
  title?: string;
  hint?: string;
  returnTo?: string;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const shown = failure ?? error;

  async function start() {
    setPending(true);
    setFailure(null);
    const result = await signInWithGoogle(returnTo);
    // On success the browser is on its way to Google, so the button may stay disabled.
    if (result !== null) {
      setFailure(result);
      setPending(false);
    }
  }

  return (
    <section className="card">
      <span className="brand sign-in-mark">
        <BrandMark />
      </span>
      <h1 className="heading">{title}</h1>
      <p className="muted">{hint}</p>
      {shown && (
        <p className="error" role="alert">
          {shown}
        </p>
      )}
      <button
        type="button"
        className="button primary"
        disabled={pending}
        onClick={() => void start()}
      >
        Continue with Google
      </button>
    </section>
  );
}
