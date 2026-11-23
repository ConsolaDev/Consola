import { useCallback, useEffect, useRef, useState } from 'react';
import type { FactoriesState } from '../domain/factories';
import { factoriesService } from '../services/factories';

/**
 * The factories the person sees in the workspace, and the teams the cell lists for them, read
 * once for the dashboard: the sidebar lists them and a factory's page shows one, so the two
 * always agree. `reload` reads them again, after any create, rename or move. Only the latest
 * read's answer is shown, and a list read for another workspace never is.
 */
export function useFactories(workspaceId: string): {
  state: FactoriesState | null;
  reload: () => Promise<void>;
} {
  const [loaded, setLoaded] = useState<{ workspaceId: string; state: FactoriesState } | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const asked = ++latest.current;
    const state = await factoriesService.loadFactories({ id: workspaceId });
    if (asked === latest.current) setLoaded({ workspaceId, state });
  }, [workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current++;
    };
  }, [reload]);

  return { state: loaded?.workspaceId === workspaceId ? loaded.state : null, reload };
}
