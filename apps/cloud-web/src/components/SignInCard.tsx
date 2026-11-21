import { signInWithGoogle } from '../authClient';

export function SignInCard({ orgName, error }: { orgName: string | null; error: string | null }) {
  return (
    <section className="card">
      <h1 className="heading">Sign in to {orgName ?? 'Consola Cloud'}</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="button" onClick={() => void signInWithGoogle()}>
        Continue with Google
      </button>
    </section>
  );
}
