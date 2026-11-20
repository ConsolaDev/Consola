import { useRef, useState, type ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowLeft, ArrowRight, Camera, ExternalLink, RotateCw, X } from 'lucide-react';
import { isAllowedPageUrl, type BrowserTabSnapshot } from '../../../shared/browser';
import { browserBridge } from '../../services/browserBridge';
import { terminalBridge } from '../../services/terminalBridge';
import { formatDroppedPaths } from '../Terminal/useTerminalFileDrop';
import { AddressBar } from './AddressBar';
import { BrowserMoreMenu } from './BrowserMoreMenu';
import { useShownError } from './BrowserError';
import { showToast } from '../../stores/toastStore';
import { addressText, isBlankUrl } from './browserView';
import { singleFlight } from './singleFlight';

interface BrowserToolbarProps {
  /** The session's active tab; none while the session has no pages. */
  tab: BrowserTabSnapshot | undefined;
  /** Opens a resolved address. Resolves false when Consola refused it. */
  onOpen: (url: string) => Promise<boolean>;
  /** The session's terminal, where a screenshot's path is pasted. */
  instanceId: string;
  /** The session's checkout, for writing the pasted path as a file drop does. */
  cwd: string;
}

/**
 * Back, forward, reload or stop, the address bar, and a way out to the
 * system browser. Every action goes to main by tab id: the page itself is
 * never touched from here. Key it by the tab, as `nextToolbarMount` does, so
 * an address being typed and a held error belong to one tab only.
 */
export function BrowserToolbar({ tab, onOpen, instanceId, cwd }: BrowserToolbarProps) {
  const shownError = useShownError(tab);
  const address = addressText(tab, shownError);
  const loading = tab?.loading ?? false;
  // Only a page that is loaded can be photographed: a blank or unloaded tab
  // has nothing to show.
  const [capturing, setCapturing] = useState(false);
  const flight = useRef(singleFlight());
  const canCapture = !capturing && !!tab?.live && !!tab.url && !isBlankUrl(tab.url);

  // Pasted, never submitted: the person decides what to say about it, exactly
  // as with a file dropped on the terminal. Main writes the file; the image
  // itself never reaches this window.
  // One capture at a time: a second click while one is pending would paste a
  // second path. A page that cannot be captured says so rather than doing nothing.
  const sendScreenshot = async () => {
    if (!tab) return;
    setCapturing(true);
    try {
      await flight.current(async () => {
        const file = await browserBridge.capture(tab.id);
        if (file) terminalBridge.paste(instanceId, formatDroppedPaths([file], cwd));
        else showToast('Could not capture this page');
      });
    } catch {
      showToast('Could not capture this page');
    } finally {
      setCapturing(false);
    }
  };

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
        <AddressBar tabId={tab?.id ?? null} address={address} onOpen={onOpen} />
        <ToolbarButton
          label="Open in system browser"
          disabled={!isAllowedPageUrl(address)}
          // Main hands a window.open of a web address to the system browser.
          onClick={() => window.open(address, '_blank')}
        >
          <ExternalLink size={14} />
        </ToolbarButton>
        <ToolbarButton
          label="Send a screenshot to the session"
          disabled={!canCapture}
          onClick={() => void sendScreenshot()}
        >
          <Camera size={14} />
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
