import type { Me } from '../domain/me';
import { regionName, roleName } from '../domain/workspace';

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

/**
 * Who is signed in, and their part in the workspace open. `hasWorkspaces` says whether a
 * person with none open is in any, so the card never says "not in a workspace" to a member.
 * `withWorkspace` false leaves the workspace line out, for a page that already says it.
 */
export function ProfileCard({
  me,
  hasWorkspaces,
  withWorkspace = true,
}: {
  me: Me;
  hasWorkspaces: boolean;
  withWorkspace?: boolean;
}) {
  const { user, workspace } = me;
  return (
    <section className="card profile">
      {user.image ? (
        <img className="avatar" src={user.image} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
      )}
      <h1 className="heading">{user.name}</h1>
      <p className="muted">{user.email}</p>
      {!withWorkspace ? null : workspace ? (
        <p>
          {roleName(workspace.role)} of {workspace.name}{' '}
          <span className="muted">· {regionName(workspace.region)} region</span>
        </p>
      ) : (
        <p>{hasWorkspaces ? 'No workspace is open.' : 'You’re not in a workspace yet.'}</p>
      )}
    </section>
  );
}
