import { useEffect, useState } from 'react';
import type { MeState, Org } from '../domain/me';
import { messageForSignInError } from '../domain/messages';
import { loadMe, loadOrg } from '../services/api';
import { takeSignInErrorCode } from '../services/signInRedirect';
import { Footer } from './Footer';
import { ProfileCard } from './ProfileCard';
import { SignInCard } from './SignInCard';
import { SignOutButton } from './SignOutButton';

export function App() {
  const [error] = useState(() => messageForSignInError(takeSignInErrorCode()));
  const [state, setState] = useState<MeState | null>(null);
  const [org, setOrg] = useState<Org | null>(null);

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
