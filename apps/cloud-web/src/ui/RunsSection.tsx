import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { NO_FILTERS } from '../domain/runFilters';
import { hashOfRunsList, runsRouteOfHash } from '../domain/runsRoute';
import type { WorkspaceMember } from '../domain/teams';
import { runsService } from '../services/runs';
import { currentRunsHash, onRunsAddressChange } from '../services/runsAddress';
import { RunPage } from './RunPage';
import { RunsList } from './RunsList';
import type { SectionProps } from './sections';
import './RunsSection.css';

/**
 * The Runs section: the workspace's runs, as a list (`#/runs`, its filters after `?`) or one run
 * (`#/runs/<id>`), whichever the address names. Both live in the workspace's regional cell; the
 * names of the people who started them come from `cloud-global`, read once as the section opens.
 *
 * The section remembers the list's address as it last showed it, so a run's page leads back to
 * the list the person came from, filters and all.
 */
export function RunsSection({ workspace }: SectionProps) {
  const hash = useSyncExternalStore(onRunsAddressChange, currentRunsHash);
  const route = useMemo(() => runsRouteOfHash(hash), [hash]);
  const listHash = useRef(hashOfRunsList(NO_FILTERS));
  if (route.kind === 'list') listHash.current = hashOfRunsList(route.filters);
  const members = useMembers(workspace.id);

  return route.kind === 'list' ? (
    <RunsList workspace={workspace} filters={route.filters} members={members} />
  ) : (
    <RunPage
      key={route.runId}
      workspace={workspace}
      runId={route.runId}
      members={members}
      listHash={listHash.current}
    />
  );
}

/**
 * The workspace's members, to name who started each run, or null while they are not known (not
 * read yet, or not to be had: a run then names nobody, and the list says why it could not load).
 */
function useMembers(workspaceId: string): WorkspaceMember[] | null {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  useEffect(() => {
    let live = true;
    void runsService.loadMembers({ id: workspaceId }).then((answer) => {
      if (live && answer.kind === 'listed') setMembers(answer.members);
    });
    return () => {
      live = false;
    };
  }, [workspaceId]);
  return members;
}
