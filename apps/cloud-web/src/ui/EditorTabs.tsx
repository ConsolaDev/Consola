import { FileCode2, FileText, X } from 'lucide-react';
import type { FactoryTabs } from '../domain/factoryTabs';

/**
 * The files open on a factory's definition, as tabs over the editor. A tab names its file (a
 * skill's file by its skill too, as `release/SKILL.md`), shows a dot once the file is changed and
 * a count while it has problems; its × closes it, and keeps its changes. The dot gives way to the
 * × under the pointer, as editors do.
 */
export function EditorTabs({
  tabs,
  changed,
  counts,
  onSelect,
  onClose,
}: {
  tabs: FactoryTabs;
  changed: ReadonlySet<string>;
  counts: ReadonlyMap<string, number>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.open.length === 0) return null;
  return (
    <div className="editor-tabs" role="toolbar" aria-label="Open files">
      {tabs.open.map((path) => {
        const name = tabName(path);
        const active = path === tabs.active;
        const count = counts.get(path) ?? 0;
        const Icon = /\.md$/i.test(path) ? FileText : FileCode2;
        return (
          <div
            key={path}
            className="editor-tab"
            data-active={active ? '' : undefined}
            data-changed={changed.has(path) ? '' : undefined}
          >
            <button
              type="button"
              className="editor-tab-open"
              aria-current={active ? 'true' : undefined}
              title={path}
              onClick={() => onSelect(path)}
            >
              <Icon size={13} aria-hidden="true" />
              <span className="editor-tab-name">{name}</span>
              {count > 0 && (
                <span className="file-problems" aria-hidden="true">
                  {count}
                </span>
              )}
              <span className="sr-only">
                {changed.has(path) ? ', changed' : ''}
                {count > 0 ? `, ${count === 1 ? '1 problem' : `${count} problems`}` : ''}
              </span>
            </button>
            <button
              type="button"
              className="editor-tab-close"
              aria-label={`Close ${name}`}
              title={changed.has(path) ? 'Close (your changes stay)' : 'Close'}
              onClick={() => onClose(path)}
            >
              <span className="editor-tab-dot" aria-hidden="true" />
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** A tab's name: the file's own, with its skill's for a file inside one. */
function tabName(path: string): string {
  const parts = path.split('/');
  if (parts[0] === 'skills' && parts.length > 2) return parts.slice(1).join('/');
  return parts[parts.length - 1] ?? path;
}
