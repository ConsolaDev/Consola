import { useState } from 'react';
import { signInWithGoogle } from '../services/authClient';
import { BrandMark } from './BrandMark';

export function SignInCard({ error }: { error: string | null }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const shown = failure ?? error;

  async function start() {
    setPending(true);
    setFailure(null);
    const result = await signInWithGoogle();
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
      <h1 className="heading">Sign in to Consola Cloud</h1>
      <p className="muted">Open your workspaces, or create your first one.</p>
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
