import { useEffect } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FolderOpen } from 'lucide-react';
import type { OpenInTarget } from '../../../shared/openIn';
import {
  loadOpenInTargets,
  openFolderIn,
  pickOpenIn,
  useOpenInFavourite,
  useOpenInStore,
} from '../../stores/openInStore';
import { OPEN_IN_ARIA_KEYSHORTCUTS, OPEN_IN_SHORTCUT_LABEL } from '../../utils/openInShortcut';

/**
 * Under the Folder row: opens the session's folder (`folder`, the path the
 * row copies) in an app. The main part opens it in the favourite, the app
 * last picked, else Finder; the chevron lists every app main found, each
 * with its own icon, and picking one opens the folder there and makes it the
 * favourite, which ⌘O then uses too.
 *
 * It takes the keyboard only when the person opens the menu, and the menu
 * hands it back to the chevron on closing (Radix's own). The list is asked
 * of main when the button first shows and each time the menu opens; until
 * main first answers, the button is drawn, so nothing below it moves, but
 * does nothing.
 */
export function OpenInButton({ folder }: { folder: string }) {
  const targets = useOpenInStore((state) => state.targets);
  const favourite = useOpenInFavourite();

  useEffect(() => {
    if (useOpenInStore.getState().targets === null) void loadOpenInTargets();
  }, []);

  return (
    <div className="info-open-in">
      <button
        type="button"
        className="info-open-in-main"
        disabled={!favourite}
        title={
          favourite
            ? `Open the folder in ${favourite.label} (${OPEN_IN_SHORTCUT_LABEL})`
            : undefined
        }
        aria-keyshortcuts={OPEN_IN_ARIA_KEYSHORTCUTS}
        onClick={() => {
          if (favourite) void openFolderIn(favourite, folder);
        }}
      >
        <AppIcon target={favourite} />
        <span className="info-open-in-label">
          {favourite ? `Open in ${favourite.label}` : 'Open in…'}
        </span>
      </button>
      <DropdownMenu.Root
        onOpenChange={(open) => {
          if (open) void loadOpenInTargets();
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="info-open-in-more"
            disabled={!targets}
            aria-label="Choose an app to open the folder in"
            title="Choose an app to open the folder in"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content info-open-in-menu"
            align="end"
            sideOffset={4}
            collisionPadding={8}
          >
            {(targets ?? []).map((target) => {
              const isFavourite = target.id === favourite?.id;
              return (
                <DropdownMenu.Item
                  key={target.id}
                  className="dropdown-item info-open-in-item"
                  aria-keyshortcuts={isFavourite ? OPEN_IN_ARIA_KEYSHORTCUTS : undefined}
                  onSelect={() => {
                    void pickOpenIn(target, folder);
                  }}
                >
                  <AppIcon target={target} />
                  <span className="info-open-in-item-label">{target.label}</span>
                  {isFavourite && (
                    <span className="info-open-in-shortcut" aria-hidden="true">
                      {OPEN_IN_SHORTCUT_LABEL}
                    </span>
                  )}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** The app's own icon, as main read it; a folder while there is none. */
function AppIcon({ target }: { target: OpenInTarget | undefined }) {
  return (
    <span className="info-open-in-icon" aria-hidden="true">
      {target?.icon ? (
        <img src={target.icon} alt="" width={16} height={16} />
      ) : (
        <FolderOpen size={14} />
      )}
    </span>
  );
}
