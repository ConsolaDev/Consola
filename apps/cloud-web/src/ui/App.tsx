import { useCallback, useEffect, useRef, useState } from 'react';
import type { Me, MeState } from '../domain/me';
import { messageForSignInError } from '../domain/messages';
import type { MyWorkspace, WorkspacesState } from '../domain/workspace';
import { loadMe, loadWorkspaces } from '../services/api';
import { takeSignInErrorCode } from '../services/signInRedirect';
import { currentSlackLinkToken, onSlackLinkChange } from '../services/slackAddress';
import { CreateWorkspaceCard } from './CreateWorkspaceCard';
import { Dashboard } from './Dashboard';
import { Footer } from './Footer';
import { ProfileCard } from './ProfileCard';
import { SignInCard } from './SignInCard';
import { SignOutButton } from './SignOutButton';
import { SlackLinkPage } from './SlackLinkPage';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** What the page shows: who is signed in, and the workspaces they are in. */
type Page = { me: MeState; workspaces: WorkspacesState };

export function App() {
  const [error] = useState(() => messageForSignInError(takeSignInErrorCode()));
  const [page, setPage] = useState<Page | null>(null);
  const [creating, setCreating] = useState(false);
  // A one-time link from Slack (`#/slack/link/<token>`) is its own page, whoever is signed in.
  const [slackLink, setSlackLink] = useState(() => currentSlackLinkToken());
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

  useEffect(() => onSlackLinkChange(setSlackLink), []);

  const afterCreate = useCallback(async () => {
    await load();
    setCreating(false);
  }, [load]);

  // A one-time link from Slack stays narrow, as sign-in does, and signs in back to itself.
  if (slackLink !== null && !creating) {
    return (
      <div className="page">
        <main className="main">
          <SlackLinkPage
            key={slackLink}
            token={slackLink}
            me={page?.me ?? null}
            workspaces={page?.workspaces.kind === 'listed' ? page.workspaces.workspaces : null}
            signInError={error}
            onSwitched={load}
            onCreate={() => setCreating(true)}
          />
        </main>
        <Footer />
      </div>
    );
  }

  // The dashboard has the whole window; sign-in, the create form and the notices stay narrow.
  if (page?.me.kind === 'signed-in' && page.me.me.workspace && !creating) {
    return (
      <Dashboard
        me={page.me.me}
        workspace={page.me.me.workspace}
        workspaces={page.workspaces.kind === 'listed' ? page.workspaces.workspaces : null}
        onSwitched={load}
        onCreate={() => setCreating(true)}
      />
    );
  }

  return (
    <div className="page">
      <main className="main">
        {page &&
          (page.me.kind === 'signed-in' ? (
            <SignedIn
              me={page.me.me}
              workspaces={page.workspaces.kind === 'listed' ? page.workspaces.workspaces : null}
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
 * The narrow page for someone signed in with no dashboard showing: one with no workspace open
 * sees their profile and the create form, and one with a workspace who chose "Create
 * workspace…" sees the form alone, with Cancel back to the dashboard. `workspaces` is null when
 * they could not be listed.
 */
function SignedIn({
  me,
  workspaces,
  onCreate,
  onCancel,
  onCreated,
  onSwitched,
}: {
  me: Me;
  workspaces: MyWorkspace[] | null;
  onCreate: () => void;
  onCancel: () => void;
  onCreated: () => Promise<void>;
  onSwitched: () => Promise<void>;
}) {
  const hasWorkspaces = me.workspace !== null || (workspaces?.length ?? 0) > 0;

  return (
    <>
      <header className="topbar">
        <span className="brand-name">Consola Cloud</span>
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
      {!me.workspace && <ProfileCard me={me} hasWorkspaces={hasWorkspaces} />}
      <CreateWorkspaceCard
        first={!hasWorkspaces}
        onCreated={onCreated}
        onCancel={me.workspace ? onCancel : undefined}
      />
    </>
  );
}
