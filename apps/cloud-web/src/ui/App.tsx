import { useEffect, useState } from 'react';
import type { MeState } from '../domain/me';
import { messageForSignInError } from '../domain/messages';
import { loadMe } from '../services/api';
import { takeSignInErrorCode } from '../services/signInRedirect';
import { Footer } from './Footer';
import { ProfileCard } from './ProfileCard';
import { SignInCard } from './SignInCard';
import { SignOutButton } from './SignOutButton';

export function App() {
  const [error] = useState(() => messageForSignInError(takeSignInErrorCode()));
  const [state, setState] = useState<MeState | null>(null);

  useEffect(() => {
    let current = true;
    void loadMe().then((nextState) => {
      if (current) setState(nextState);
    });
    return () => {
      current = false;
    };
  }, []);

  return (
    <div className="page">
      <main className="main">{state && view(state, error)}</main>
      <Footer />
    </div>
  );
}

function view(state: MeState, error: string | null) {
  switch (state.kind) {
    case 'signed-out':
      return <SignInCard error={error} />;
    case 'signed-in':
      return (
        <>
          <header className="topbar">
            <span>Consola Cloud{state.me.workspace ? ` · ${state.me.workspace.name}` : ''}</span>
            <SignOutButton className="link-button" />
          </header>
          <ProfileCard me={state.me} />
        </>
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
