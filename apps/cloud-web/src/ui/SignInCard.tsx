import { useState } from 'react';
import { signInWithGoogle } from '../services/authClient';

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
      <h1 className="heading">Sign in to Consola Cloud</h1>
      {shown && (
        <p className="error" role="alert">
          {shown}
        </p>
      )}
      <button type="button" className="button" disabled={pending} onClick={() => void start()}>
        Continue with Google
      </button>
    </section>
  );
}
