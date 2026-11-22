import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, MeState } from '../domain/me';
import { messageForSignInError } from '../domain/messages';
import type { MyWorkspace, WorkspacesState } from '../domain/workspace';
import { loadMe, loadWorkspaces } from '../services/api';
import { takeSignInErrorCode } from '../services/signInRedirect';
import { CreateWorkspaceCard } from './CreateWorkspaceCard';
import { Dashboard } from './Dashboard';
import { Footer } from './Footer';
import { ProfileCard } from './ProfileCard';
import { SignInCard } from './SignInCard';
import { SignOutButton } from './SignOutButton';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** What the page shows: who is signed in, and the workspaces they are in. */
type Page = { me: MeState; workspaces: WorkspacesState };

export function App() {
  const [error] = useState(() => messageForSignInError(takeSignInErrorCode()));
  const [page, setPage] = useState<Page | null>(null);
  const [creating, setCreating] = useState(false);
  // Each load is numbered, so only the latest one's answer is shown.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const asked = ++latest.current;
    const [me, workspaces] = await Promise.all([loadMe(), loadWorkspaces()]);
    if (asked === latest.current) setPage({ me, workspaces });
  }, []);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const afterCreate = useCallback(async () => {
    await load();
    setCreating(false);
  }, [load]);

  // The dashboard needs the page's width; sign-in, the create form and the notices stay narrow.
  const dashboard = page?.me.kind === 'signed-in' && page.me.me.workspace !== null && !creating;

  return (
    <div className="page">
      <main className={dashboard ? 'main wide' : 'main'}>
        {page &&
          (page.me.kind === 'signed-in' ? (
            <SignedIn
              me={page.me.me}
              workspaces={page.workspaces.kind === 'listed' ? page.workspaces.workspaces : null}
              creating={creating}
              onCreate={() => setCreating(true)}
              onCancel={() => setCreating(false)}
              onCreated={afterCreate}
              onSwitched={load}
            />
          ) : page.me.kind === 'signed-out' ? (
            <SignInCard error={error} />
          ) : (
            <section className="card">
              <p>
                Consola Cloud’s service isn’t answering. Start it with <code>pnpm dev:cloud</code>{' '}
                and reload.
              </p>
            </section>
          ))}
      </main>
      <Footer />
    </div>
  );
}

/**
 * The page for someone signed in. A person with a workspace open sees it in the topbar's
 * switcher and its dashboard below; one with none open sees their profile and the create form,
 * which a person with a workspace reaches from the switcher. `workspaces` is null when they
 * could not be listed.
 */
function SignedIn({
  me,
  workspaces,
  creating,
  onCreate,
  onCancel,
  onCreated,
  onSwitched,
}: {
  me: Me;
  workspaces: MyWorkspace[] | null;
  creating: boolean;
  onCreate: () => void;
  onCancel: () => void;
  onCreated: () => Promise<void>;
  onSwitched: () => Promise<void>;
}) {
  const hasWorkspaces = me.workspace !== null || (workspaces?.length ?? 0) > 0;
  const showForm = me.workspace === null || creating;

  return (
    <>
      <header className="topbar">
        <span className="brand">Consola Cloud</span>
        {hasWorkspaces && (
          <>
            <span className="crumb" aria-hidden="true">
              /
            </span>
            <WorkspaceSwitcher
              active={me.workspace}
              workspaces={workspaces}
              onSwitched={onSwitched}
              onCreate={onCreate}
            />
          </>
        )}
        <SignOutButton className="link-button" />
      </header>
      {me.workspace && !creating && <Dashboard me={me} workspace={me.workspace} />}
      {!me.workspace && <ProfileCard me={me} hasWorkspaces={hasWorkspaces} />}
      {showForm && (
        <CreateWorkspaceCard
          first={!hasWorkspaces}
          onCreated={onCreated}
          onCancel={me.workspace ? onCancel : undefined}
        />
      )}
    </>
  );
}
