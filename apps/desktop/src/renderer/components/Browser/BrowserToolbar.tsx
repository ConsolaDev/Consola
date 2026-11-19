import type { ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from 'lucide-react';
import { isAllowedPageUrl, type BrowserTabSnapshot } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { AddressBar } from './AddressBar';
import { BrowserMoreMenu } from './BrowserMoreMenu';
import { useShownError } from './BrowserError';
import { addressText } from './browserView';

interface BrowserToolbarProps {
  /** The session's active tab; none while the session has no pages. */
  tab: BrowserTabSnapshot | undefined;
  /** Opens a resolved address. Resolves false when Consola refused it. */
  onOpen: (url: string) => Promise<boolean>;
}

/**
 * Back, forward, reload or stop, the address bar, and a way out to the
 * system browser. Every action goes to main by tab id: the page itself is
 * never touched from here. Key it by the tab, so an address being typed and a
 * held error belong to one tab only.
 */
export function BrowserToolbar({ tab, onOpen }: BrowserToolbarProps) {
  const shownError = useShownError(tab);
  const address = addressText(tab, shownError);
  const loading = tab?.loading ?? false;

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="browser-toolbar">
        <ToolbarButton
          label="Back"
          disabled={!tab?.canGoBack}
          onClick={() => tab && void browserBridge.back(tab.id)}
        >
          <ArrowLeft size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Forward"
          disabled={!tab?.canGoForward}
          onClick={() => tab && void browserBridge.forward(tab.id)}
        >
          <ArrowRight size={14} />
        </ToolbarButton>
        {/* One button whose job changes, so focus stays put when a load ends. */}
        <ToolbarButton
          label={loading ? 'Stop' : 'Reload'}
          disabled={!tab?.url}
          onClick={() => {
            if (!tab) return;
            void (loading ? browserBridge.stop(tab.id) : browserBridge.reload(tab.id));
          }}
        >
          {loading ? <X size={14} /> : <RotateCw size={14} />}
        </ToolbarButton>
        <AddressBar address={address} onOpen={onOpen} />
        <ToolbarButton
          label="Open in system browser"
          disabled={!isAllowedPageUrl(address)}
          // Main hands a window.open of a web address to the system browser.
          onClick={() => window.open(address, '_blank')}
        >
          <ExternalLink size={14} />
        </ToolbarButton>
        <BrowserMoreMenu tabId={tab?.id} />
      </div>
    </Tooltip.Provider>
  );
}

interface ToolbarButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

function ToolbarButton({ label, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          className="browser-toolbar-button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={5}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
