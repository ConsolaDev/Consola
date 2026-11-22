import { regionName, roleName } from '../domain/workspace';
import { ProfileCard } from './ProfileCard';
import type { SectionProps } from './sections';

/** The dashboard's first page: the workspace open, the person's part in it, and who they are. */
export function OverviewPage({ me, workspace }: SectionProps) {
  return (
    <>
      <header className="section-header">
        <h1 className="section-title">{workspace.name}</h1>
      </header>
      <section className="card">
        <dl className="facts">
          <dt>Region</dt>
          <dd>
            {regionName(workspace.region)}{' '}
            <span className="muted">
              · chosen when the workspace was created, and it can’t change
            </span>
          </dd>
          <dt>Slug</dt>
          <dd>
            <code>{workspace.slug}</code>
          </dd>
          <dt>Your role</dt>
          <dd>{roleName(workspace.role)}</dd>
        </dl>
      </section>
      <ProfileCard me={me} hasWorkspaces withWorkspace={false} />
    </>
  );
}
