import { useEffect, useMemo, useState } from 'react';
import type { Session } from '../../shared/workspace';
import { harnessBridge } from '../services/harnessBridge';
import { useHarnessStore } from '../stores/harnessStore';

/** Read runtime metadata without changing the model pinned for future launches. */
export function useSessionModel(session: Session, enabled: boolean): string | undefined {
  const harnesses = useHarnessStore((state) => state.harnesses);
  const getLaunchFields = useHarnessStore((state) => state.getLaunchFields);
  const fields = useMemo(
    () => getLaunchFields(session.harnessId),
    [harnesses, getLaunchFields, session.harnessId]
  );
  const [runtime, setRuntime] = useState<{ key: string; model: string }>();
  const key = JSON.stringify([session.claudeSessionId, fields]);

  useEffect(() => {
    if (!enabled || !session.claudeSessionId) return;
    if (fields.driverId && fields.driverId !== 'claude' && fields.driverId !== 'codex') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const model = await harnessBridge.getSessionModel(session.claudeSessionId, fields);
        if (!cancelled && model) setRuntime({ key, model });
      } catch {
        // Keep the last known model while the transcript is unavailable.
      } finally {
        if (!cancelled) timer = setTimeout(refresh, 5000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, session.claudeSessionId, fields, key]);

  return runtime?.key === key ? runtime.model : session.model;
}
