import { Lock } from 'lucide-react';
import { regionName, regionPlace, roleName } from '../domain/workspace';
import type { SectionProps } from './sections';
import { WorkspaceIconPicker } from './WorkspaceIconPicker';
import './GeneralPage.css';

/**
 * Settings' first page: the workspace itself, as the desktop app's General page shows one (its
 * `WorkspaceSettings/ManifestHeader.tsx`): its icon, which an owner or admin changes from the
 * tile, beside its name over a quiet row of its facts. Under it, what cannot change.
 */
export function GeneralPage({ workspace, onWorkspaceChanged }: SectionProps) {
  const place = regionPlace(workspace.region);

  return (
    <section className="settings-section general">
      <h2 className="settings-section-title">General</h2>

      <div className="general-manifest">
        <WorkspaceIconPicker workspace={workspace} onChanged={onWorkspaceChanged} />
        <div className="general-manifest-text">
          <p className="general-manifest-name">{workspace.name}</p>
          <p className="general-manifest-facts">
            <span>{workspace.slug}</span>
            <span>{regionName(workspace.region)}</span>
            <span>
              <span className="sr-only">Your role: </span>
              {roleName(workspace.role)}
            </span>
          </p>
        </div>
      </div>

      <div className="settings-option">
        <div className="settings-option-info">
          <p className="settings-option-label">Icon</p>
          <p className="settings-option-description">
            Shown beside the workspace’s name in the sidebar and its menu.{' '}
            {workspace.canManage
              ? 'Choose it from the tile above.'
              : 'Only owners and admins can change it.'}
          </p>
        </div>
      </div>

      <div className="settings-option">
        <div className="settings-option-info">
          <p className="settings-option-label">
            Region
            <span className="settings-chip">
              <Lock size={12} aria-hidden="true" /> Fixed
            </span>
          </p>
          <p className="settings-option-description">
            {place ? `${place}. ` : ''}Chosen when the workspace was created, and it can’t change.
          </p>
        </div>
      </div>
    </section>
  );
}
