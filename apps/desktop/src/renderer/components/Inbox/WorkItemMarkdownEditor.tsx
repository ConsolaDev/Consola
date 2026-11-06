import { useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import {
  Bold,
  Code,
  Diff,
  Heading,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  TextQuote,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { MOD_KEY, isSubmitChord } from './inboxPresentation';
import { applyFormat, insertSuggestion, insertText, type MarkdownFormat, type TextEdit } from './markdownEditing';
import { WorkItemMarkdown } from './WorkItemDetailParts';

export interface MarkdownEditorHandle {
  focus: () => void;
  /** Text at the caret (a quote reply), focused and scrolled into view. */
  insert: (text: string) => void;
}

const TOOLS: Array<{ format: MarkdownFormat; label: string; icon: LucideIcon; compact?: boolean }> = [
  { format: 'heading', label: 'Heading', icon: Heading },
  { format: 'bold', label: 'Bold', icon: Bold, compact: true },
  { format: 'italic', label: 'Italic', icon: Italic, compact: true },
  { format: 'quote', label: 'Quote', icon: TextQuote },
  { format: 'code', label: 'Code', icon: Code, compact: true },
  { format: 'link', label: 'Link', icon: Link, compact: true },
  { format: 'numbered', label: 'Numbered list', icon: ListOrdered },
  { format: 'bulleted', label: 'Bulleted list', icon: List },
  { format: 'task', label: 'Task list', icon: ListTodo },
];

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** The textarea's accessible name. */
  label: string;
  placeholder?: string;
  /** `compact` is a line comment's: bold, italic, code, link (and Suggest a change). */
  toolbar?: 'full' | 'compact';
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** ⌘↵ (Ctrl↵): what the form's main button does. */
  onSubmit?: () => void;
  /** Esc, handled here so the Inbox's own Esc does not close the pane. */
  onCancel?: () => void;
  /** The selected lines' new text: offers "Suggest a change" when there is some. */
  suggestion?: string | null;
  ref?: Ref<MarkdownEditorHandle>;
}

/**
 * Where a comment is written, as on GitHub: Write and Preview, a toolbar
 * that wraps the selection or inserts at the caret, and ⌘↵ to send. In the
 * narrowest pane the toolbar folds behind one button.
 */
export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder = 'Leave a comment',
  toolbar = 'full',
  rows = 4,
  disabled = false,
  autoFocus = false,
  onSubmit,
  onCancel,
  suggestion,
  ref,
}: Props) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [toolsOpen, setToolsOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const uid = useId();

  const commit = (edit: TextEdit) => {
    onChange(edit.value);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  };
  const selection = () => {
    const node = field.current;
    return { start: node?.selectionStart ?? value.length, end: node?.selectionEnd ?? value.length };
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      setMode('write');
      requestAnimationFrame(() => field.current?.focus());
    },
    insert: (text) => {
      setMode('write');
      const { start, end } = selection();
      commit(insertText(value, start, end, text));
      requestAnimationFrame(() => field.current?.scrollIntoView({ block: 'center' }));
    },
  }));

  const format = (kind: MarkdownFormat) => {
    const { start, end } = selection();
    commit(applyFormat(value, start, end, kind));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitChord(event) && onSubmit) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  const tools = TOOLS.filter((tool) => toolbar === 'full' || tool.compact);
  return (
    <div className="inbox-detail-md" data-mode={mode}>
      <div className="inbox-detail-md-head">
        <div className="inbox-detail-md-tabs" role="tablist" aria-label={`${label}: write or preview`}>
          {(['write', 'preview'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${uid}-${name}`}
              aria-selected={mode === name}
              aria-controls={`${uid}-body`}
              className="inbox-detail-md-tab"
              onClick={() => setMode(name)}
            >
              {name === 'write' ? 'Write' : 'Preview'}
            </button>
          ))}
        </div>
        {mode === 'write' && (
          <>
            <button
              type="button"
              className="inbox-detail-icon-btn inbox-detail-md-toggle"
              aria-label="Formatting"
              aria-expanded={toolsOpen}
              title="Formatting"
              onClick={() => setToolsOpen(!toolsOpen)}
            >
              <Type size={14} aria-hidden="true" />
            </button>
            <div className="inbox-detail-md-tools" role="toolbar" aria-label="Formatting" data-open={toolsOpen || undefined}>
              {tools.map(({ format: kind, label: name, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  className="inbox-detail-icon-btn"
                  aria-label={name}
                  title={name}
                  disabled={disabled}
                  // Keep the selection: the edit applies to it.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => format(kind)}
                >
                  <Icon size={14} aria-hidden="true" />
                </button>
              ))}
              {suggestion != null && (
                <button
                  type="button"
                  className="inbox-detail-btn inbox-detail-btn--small inbox-detail-btn--quiet"
                  disabled={disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const { start, end } = selection();
                    commit(insertSuggestion(value, start, end, suggestion));
                  }}
                >
                  <Diff size={13} aria-hidden="true" />
                  Suggest a change
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div id={`${uid}-body`} role="tabpanel" aria-labelledby={`${uid}-${mode}`}>
        {mode === 'write' ? (
          <textarea
            ref={field}
            aria-label={label}
            aria-keyshortcuts={onSubmit ? (MOD_KEY === '⌘' ? 'Meta+Enter' : 'Control+Enter') : undefined}
            placeholder={placeholder}
            value={value}
            maxLength={65536}
            disabled={disabled}
            rows={rows}
            autoFocus={autoFocus}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <div className="inbox-detail-md-preview">
            {value.trim() ? <WorkItemMarkdown content={value} /> : <p className="inbox-detail-empty">Nothing to preview.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
