import { useEffect, useState } from 'react';
import { loadMe, loadOrg, type MeState } from './api';
import { Footer } from './components/Footer';
import { ProfileCard } from './components/ProfileCard';
import { SignInCard } from './components/SignInCard';
import { SignOutButton } from './components/SignOutButton';
import { messageForSignInError } from './signInError';

type Org = { name: string; slug: string } | null;

/** Reads `?error=` once and removes it, so a reload does not show it again. */
function takeSignInError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('error');
  if (code === null) return null;
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return messageForSignInError(code);
}

export function App() {
  const [error] = useState(takeSignInError);
  const [state, setState] = useState<MeState | null>(null);
  const [org, setOrg] = useState<Org>(null);

  useEffect(() => {
    let current = true;
    void Promise.all([loadOrg(), loadMe()]).then(([nextOrg, nextState]) => {
      if (!current) return;
      setOrg(nextOrg);
      setState(nextState);
    });
    return () => {
      current = false;
    };
  }, []);

  const orgName = org?.name ?? null;

  return (
    <div className="page">
      <main className="main">{state && view(state, orgName, error)}</main>
      <Footer />
    </div>
  );
}

function view(state: MeState, orgName: string | null, error: string | null) {
  switch (state.kind) {
    case 'signed-out':
      return <SignInCard orgName={orgName} error={error} />;
    case 'signed-in':
      return (
        <>
          <header className="topbar">
            <span>Consola Cloud · {state.me.organization.name}</span>
            <SignOutButton className="link-button" />
          </header>
          <ProfileCard me={state.me} />
        </>
      );
    case 'not-member':
      return (
        <section className="card">
          <p>
            You’re signed in, but not a member of {orgName ?? 'this organisation'}. Sign out and
            sign in again.
          </p>
          <SignOutButton className="button" />
        </section>
      );
    case 'unavailable':
      return (
        <section className="card">
          <p>
            Consola Cloud’s service isn’t answering. Start it with <code>pnpm dev:cloud</code> and
            reload.
          </p>
        </section>
      );
  }
}
