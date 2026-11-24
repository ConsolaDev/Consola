import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bug, MoreHorizontal, RefreshCcw, Search, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { zoomPercent } from '../../../shared/browserTools';
import type { ZoomStep } from '../../../shared/browserTools';
import { browserBridge } from '../../services/browserBridge';
import { requestFind } from '../../stores/browserFindStore';
import { isMac } from '../../utils/platform';
import { ClearBrowsingDataDialog } from './ClearBrowsingDataDialog';

interface BrowserMoreMenuProps {
  /** The page showing; the menu is inert while the session has none. */
  tabId: string | undefined;
}

const MOD = isMac ? '⌘' : 'Ctrl+';
const HARD_RELOAD_KEYS = isMac ? '⇧⌘R' : 'Ctrl+Shift+R';

/**
 * The toolbar's "more" menu: find, zoom, hard reload, DevTools and clearing the workspace's browsing data (confirmed first). Every item
 * goes to main by tab id, like the toolbar's buttons. Zoom keeps the menu open
 * so a few steps are a few clicks. Chromium zooms per host (as Chrome does),
 * so the level belongs to the page's site, not the tab: it is read from the
 * page each time the menu opens and after every step, never remembered here.
 */
export function BrowserMoreMenu({ tabId }: BrowserMoreMenuProps) {
  const [level, setLevel] = useState(0);
  const [clearing, setClearing] = useState(false);
  // Set when the menu closes to open the find bar, which takes the focus.
  const findOpening = useRef(false);

  const zoom = (step: ZoomStep | 'get') => {
    if (!tabId) return;
    browserBridge
      .zoom(tabId, step)
      .then(setLevel)
      .catch((error: unknown) => console.warn('In-app browser action failed:', error));
  };
  const run = (action: (tab: string) => Promise<void>) => {
    if (tabId)
      action(tabId).catch((error: unknown) => console.warn('In-app browser action failed:', error));
  };

  return (
    <>
      <DropdownMenu.Root onOpenChange={(open) => open && zoom('get')}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="browser-toolbar-button" aria-label="More" title="More">
            <MoreHorizontal size={14} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content browser-more-content"
            // Portalled out of the panel, but still the browser's own control:
            // ⌘W here closes the browser tab (`keyboardPlaceOf`).
            data-browser-control=""
            align="end"
            sideOffset={4}
            // Closing the menu to search leaves focus in the find field, not
            // back on the trigger.
            onCloseAutoFocus={(event) => {
              if (!findOpening.current) return;
              findOpening.current = false;
              event.preventDefault();
              // Only now: while the menu is open it holds the focus, and a find
              // field that took it would have it handed straight back.
              requestFind();
            }}
          >
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={() => {
                findOpening.current = true;
              }}
            >
              <Search size={14} />
              <span>Find on page</span>
              <span className="browser-menu-keys">{MOD}F</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="dropdown-separator" />
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={(event) => {
                event.preventDefault();
                zoom('in');
              }}
            >
              <ZoomIn size={14} />
              <span>Zoom in</span>
              <span className="browser-menu-keys">{MOD}+</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={(event) => {
                event.preventDefault();
                zoom('out');
              }}
            >
              <ZoomOut size={14} />
              <span>Zoom out</span>
              <span className="browser-menu-keys">{MOD}-</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={(event) => {
                event.preventDefault();
                zoom('reset');
              }}
            >
              <span className="browser-menu-icon-gap" />
              <span>Actual size</span>
              <span className="browser-menu-keys" data-testid="browser-zoom-level">
                {zoomPercent(level)}%
              </span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="dropdown-separator" />
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={() => run(browserBridge.hardReload)}
            >
              <RefreshCcw size={14} />
              <span>Hard reload</span>
              <span className="browser-menu-keys">{HARD_RELOAD_KEYS}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="dropdown-item"
              disabled={!tabId}
              onSelect={() => run(browserBridge.openDevTools)}
            >
              <Bug size={14} />
              <span>Open DevTools</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="dropdown-separator" />
            <DropdownMenu.Item className="dropdown-item" onSelect={() => setClearing(true)}>
              <Trash2 size={14} />
              <span>Clear browsing data</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ClearBrowsingDataDialog open={clearing} onOpenChange={setClearing} />
    </>
  );
}
