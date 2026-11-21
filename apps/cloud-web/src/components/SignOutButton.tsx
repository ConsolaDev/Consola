import { useState } from 'react';
import { signOut } from '../authClient';

export function SignOutButton({ className }: { className: string }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setFailure(null);
    const result = await signOut();
    // On success the page reloads.
    if (result !== null) {
      setFailure(result);
      setPending(false);
    }
  }

  return (
    <>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      <button type="button" className={className} disabled={pending} onClick={() => void run()}>
        Sign out
      </button>
    </>
  );
}
