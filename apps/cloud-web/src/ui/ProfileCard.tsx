import type { Me } from '../domain/me';
import { regionName, roleName } from '../domain/workspace';
import { Avatar } from './Avatar';

/**
 * Who is signed in, and their part in the workspace open. `hasWorkspaces` says whether a
 * person with none open is in any, so the card never says "not in a workspace" to a member.
 */
export function ProfileCard({ me, hasWorkspaces }: { me: Me; hasWorkspaces: boolean }) {
  const { user, workspace } = me;
  return (
    <section className="card profile">
      <Avatar user={user} size={48} />
      <h1 className="heading">{user.name}</h1>
      <p className="muted">{user.email}</p>
      {workspace ? (
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
