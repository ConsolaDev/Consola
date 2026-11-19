import { useState, type ReactNode } from 'react';
import { ServerCrash, ShieldAlert, Unplug } from 'lucide-react';
import type { BrowserTabError, BrowserTabSnapshot } from '../../../shared/browser';
import { nextShownError } from './browserView';

/**
 * The error drawn over a tab's page, held through the load that retries it
 * (`nextShownError`). Use it in a component keyed by the tab, so one tab's
 * error never carries over to another.
 */
export function useShownError(
  tab: Pick<BrowserTabSnapshot, 'loading' | 'error'> | undefined,
): BrowserTabError | null {
  const [shown, setShown] = useState<BrowserTabError | null>(tab?.error ?? null);
  const next = tab ? nextShownError(shown, tab) : null;
  if (next !== shown) setShown(next);
  return next;
}

interface BrowserErrorProps {
  error: BrowserTabError;
  /** A page on this machine is retried on its own while it is on screen. */
  retryingByItself: boolean;
  onRetry: () => void;
}

/** Why a page is not showing, and the one thing to do about it. */
export function BrowserError({ error, retryingByItself, onRetry }: BrowserErrorProps) {
  const { icon, title, detail, code, action } = explain(error);
  return (
    <div className="browser-error" role="alert">
      <div className="browser-error-icon">{icon}</div>
      <h3 className="browser-error-title">{title}</h3>
      {detail && <p className="browser-error-detail">{detail}</p>}
      {code && <p className="browser-error-code">{code}</p>}
      {retryingByItself && (
        <p className="browser-error-hint">Consola keeps trying while this page is open.</p>
      )}
      <button type="button" className="dialog-button-secondary" onClick={onRetry}>
        {action}
      </button>
    </div>
  );
}

function explain(error: BrowserTabError): {
  icon: ReactNode;
  title: string;
  detail: string | null;
  code: string | null;
  action: string;
} {
  switch (error.kind) {
    case 'unreachable':
      return {
        icon: <Unplug size={28} strokeWidth={1.5} />,
        title: 'This page could not be reached',
        detail: error.url,
        code: error.description,
        action: 'Retry',
      };
    case 'certificate':
      return {
        icon: <ShieldAlert size={28} strokeWidth={1.5} />,
        title: `The certificate for ${error.host} is not trusted`,
        detail: error.url,
        code: error.error,
        action: 'Retry',
      };
    case 'crashed':
      return {
        icon: <ServerCrash size={28} strokeWidth={1.5} />,
        title: 'This page stopped working',
        detail: null,
        code: null,
        action: 'Reload',
      };
  }
}
