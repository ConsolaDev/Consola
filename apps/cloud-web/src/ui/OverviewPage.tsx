import { Lock } from 'lucide-react';
import { regionName, regionPlace, roleName } from '../domain/workspace';
import { Avatar } from './Avatar';
import { CopySlug } from './CopySlug';
import { RegionMap } from './RegionMap';
import type { SectionProps } from './sections';
import { WorkspaceIcon } from './WorkspaceIcon';
import './OverviewPage.css';

/**
 * The dashboard's first page, laid out as the desktop app lays a workspace out: the workspace
 * under its icon and name, over a quiet row of its facts (its slug, which copies itself); then
 * where in the world it is, on a map; then who is looking, with their part in it.
 */
export function OverviewPage({ me, workspace }: SectionProps) {
  const place = regionPlace(workspace.region);

  return (
    <>
      <header className="overview-head">
        <span className="overview-tile">
          <WorkspaceIcon icon={workspace.icon} name={workspace.name} size={26} />
        </span>
        <div className="overview-head-text">
          <h1 className="overview-name">{workspace.name}</h1>
          <div className="overview-facts">
            <CopySlug slug={workspace.slug} />
            <span>{regionName(workspace.region)} region</span>
          </div>
        </div>
      </header>

      <section className="group" aria-labelledby="overview-region-label">
        <h2 id="overview-region-label" className="group-label">
          Region
        </h2>
        <div className="group-box overview-region">
          <div className="overview-region-text">
            <p className="overview-region-code">{regionName(workspace.region)}</p>
            {place && <p className="overview-region-place">{place}</p>}
            <p className="overview-region-note">
              <Lock size={12} aria-hidden="true" />
              Set when the workspace was created, and it can’t change.
            </p>
          </div>
          <RegionMap region={workspace.region} />
        </div>
      </section>

      <section className="group" aria-labelledby="overview-you-label">
        <h2 id="overview-you-label" className="group-label">
          You
        </h2>
        <div className="group-box overview-you">
          <Avatar user={me.user} size={28} />
          <div className="overview-you-text">
            <p className="overview-you-name">{me.user.name}</p>
            <p className="overview-you-email">{me.user.email}</p>
          </div>
          <p className="overview-role">
            <span className="sr-only">Your role: </span>
            {roleName(workspace.role)}
          </p>
        </div>
      </section>
    </>
  );
}
