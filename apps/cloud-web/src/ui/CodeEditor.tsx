import {
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  history as undoHistory,
} from '@codemirror/commands';
import { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
import {
  defineLanguageFacet,
  HighlightStyle,
  indentUnit,
  Language,
  syntaxHighlighting,
} from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';
import type { Diagnostic } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  GutterMarker,
  gutterLineClass,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { useEffect, useRef } from 'react';

/**
 * One factory file's text, editable, in CodeMirror: YAML for `.yaml` and `.yml`, Markdown with
 * YAML front matter for `.md` (an agent, a skill's `SKILL.md`), plain text otherwise. It is
 * shaded in the run page's colours (keys in the accent, strings green, numbers warm, the rest
 * quiet) and laid out in the app's monospace.
 *
 * Each file keeps its own editor state (its undo history, selection and scroll) while the person
 * moves between tabs, so switching back lands where they were. `problems` are drawn on their
 * lines: a wavy underline, its message on hover, and the line's number in the danger colour.
 * `reveal` scrolls to a line, puts the caret there and lights the line once, as a problem asks.
 *
 * The text is someone's: CodeMirror shows it as text, never markup.
 */
export function CodeEditor({
  path,
  text,
  problems,
  reveal,
  label,
  onChange,
}: {
  path: string;
  text: string;
  /** This file's problems that have a line: drawn on it. */
  problems: ReadonlyArray<{ line: number; message: string }>;
  /** A line to bring into view and light once; a new `seq` asks again. */
  reveal: { path: string; line: number; seq: number } | null;
  label: string;
  onChange: (path: string, text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const shown = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The view, made once; each file's state is swapped in below.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const made = new EditorView({ parent });
    view.current = made;
    return () => {
      made.destroy();
      view.current = null;
      shown.current = null;
    };
  }, []);

  // The file shown, and its text when it changes from outside (a newer version brought in).
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    if (shown.current !== path) {
      if (shown.current !== null) states.current.set(shown.current, current.state);
      const kept = states.current.get(path);
      const state =
        kept && kept.doc.toString() === text
          ? kept
          : EditorState.create({
              doc: text,
              extensions: extensionsFor(path, label, (next) => onChangeRef.current(path, next)),
            });
      current.setState(state);
      shown.current = path;
    } else if (current.state.doc.toString() !== text) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: text },
        annotations: [fromOutside.of(true)],
      });
    }
  }, [path, text, label]);

  // The file's problems, on their lines. Drawn again for each state swapped in.
  useEffect(() => {
    const current = view.current;
    if (!current || shown.current !== path) return;
    const { doc } = current.state;
    const diagnostics: Diagnostic[] = [];
    const lines = new Set<number>();
    for (const problem of problems) {
      if (problem.line < 1 || problem.line > doc.lines) continue;
      const line = doc.line(problem.line);
      const indent = line.text.length - line.text.trimStart().length;
      const from = line.from + Math.min(indent, line.length);
      diagnostics.push({
        from,
        to: Math.max(line.to, from),
        severity: 'error',
        message: problem.message,
      });
      lines.add(problem.line);
    }
    current.dispatch(setDiagnostics(current.state, diagnostics));
    current.dispatch({ effects: setProblemLines.of([...lines]) });
  }, [path, problems]);

  // A line to reveal: scrolled to, the caret put there, lit once.
  useEffect(() => {
    const current = view.current;
    if (!current || !reveal || reveal.path !== path) return;
    const { doc } = current.state;
    const line = doc.line(Math.min(Math.max(reveal.line, 1), doc.lines));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    current.dispatch({
      selection: { anchor: line.from },
      effects: [
        EditorView.scrollIntoView(line.from, { y: 'center' }),
        ...(reduce ? [] : [flashLine.of(line.from)]),
      ],
    });
    current.focus();
    if (reduce) return;
    const timer = window.setTimeout(() => {
      view.current?.dispatch({ effects: flashLine.of(null) });
    }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [reveal, path]);

  return <div ref={host} className="code-editor" />;
}

/** How long a revealed line stays lit: its animation's length, in `FactoryDefinition.css`. */
const FLASH_MS = 1300;

/** A change the page made (a newer version's text), which is no edit of the person's. */
const fromOutside = Annotation.define<boolean>();

/** The line lit once as it is revealed: its start, or null to put the light out. */
const flashLine = StateEffect.define<number | null>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lit, transaction) {
    let next = lit.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(flashLine)) continue;
      next =
        effect.value === null
          ? Decoration.none
          : Decoration.set([Decoration.line({ class: 'cm-flash' }).range(effect.value)]);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The lines with a problem, whose numbers the gutter draws in the danger colour. */
const setProblemLines = StateEffect.define<number[]>();

const problemLineMarker = new (class extends GutterMarker {
  elementClass = 'cm-problem-line';
})();

const problemLinesField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(marked, transaction) {
    let next = marked.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setProblemLines)) continue;
      const { doc } = transaction.state;
      next = RangeSet.of(
        effect.value
          .filter((line) => line >= 1 && line <= doc.lines)
          .sort((a, b) => a - b)
          .map((line) => problemLineMarker.range(doc.line(line).from)),
      );
    }
    return next;
  },
  provide: (field) => gutterLineClass.from(field),
});

/**
 * The run page's shading (`RunFileView.css`), in CodeMirror's terms: a key in the accent, a
 * quoted string green, a number or literal warm, punctuation and comments quiet. Markdown keeps
 * its headings and emphasis in weight and style, never in colour, but for links.
 */
const shading = HighlightStyle.define([
  { tag: [t.definition(t.propertyName), t.propertyName], color: 'var(--cyan-text)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warning)' },
  { tag: [t.separator, t.punctuation, t.meta, t.processingInstruction], color: 'var(--text-3)' },
  { tag: [t.comment, t.lineComment], color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: [t.labelName, t.typeName, t.keyword], color: 'var(--cyan-text)' },
  { tag: t.heading, fontWeight: 'var(--font-weight-semibold)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'var(--font-weight-semibold)' },
  { tag: [t.link, t.url], color: 'var(--cyan-text)' },
  { tag: [t.monospace, t.quote], color: 'var(--text-2)' },
]);

/**
 * CodeMirror's own parts in the app's tokens: the selection in the accent's muted fill, the
 * caret in the text colour, a problem's wavy underline in the danger colour, hover cards and the
 * search bar drawn as the app's menus and fields. A theme outranks CodeMirror's base styles,
 * which a stylesheet would have to out-specify; the page's layout is in `FactoryDefinition.css`.
 */
const look = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    fontSize: 'var(--font-size-md)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 0 28px', caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    { backgroundColor: 'var(--cyan-muted)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--cyan) 14%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 22%, transparent)',
    outline: 'none',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in srgb, var(--warning) 45%, transparent)',
  },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 18px', minWidth: '2ch' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 3.5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-gutterElement.cm-problem-line': { color: 'var(--danger)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--danger)',
    textDecorationThickness: '1px',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '4px',
  },
  '.cm-tooltip': {
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--bg-pop)',
    color: 'var(--text)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
  },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': {
    maxWidth: '56ch',
    padding: '6px 10px',
    border: 'none',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--font-size-sm)',
    lineHeight: 'var(--line-height-normal)',
    whiteSpace: 'pre-wrap',
  },
  '.cm-diagnostic-error': { borderLeft: 'none' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-sidebar)',
    color: 'var(--text)',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-search': { padding: '6px 10px', fontSize: 'var(--font-size-sm)' },
  '.cm-search label': { color: 'var(--text-2)' },
  '.cm-textfield': {
    padding: '3px 8px',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    fontSize: 'var(--font-size-sm)',
  },
  '.cm-button': {
    padding: '3px 10px',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-md)',
    backgroundImage: 'none',
    backgroundColor: 'transparent',
    color: 'var(--text)',
    fontSize: 'var(--font-size-sm)',
  },
  '.cm-button:hover': { backgroundColor: 'var(--hover)' },
  '.cm-search [name=close]': { color: 'var(--text-2)', fontSize: 'var(--font-size-lg)' },
});

/**
 * Markdown as GitHub writes it, for shading only, straight from its parser: CodeMirror's Markdown
 * package would bring HTML, CSS and JavaScript along for HTML inside Markdown, which no agent or
 * skill file needs, and more than doubles what the page loads.
 */
const markdownShading = new Language(
  defineLanguageFacet({}),
  markdownParser.configure(GFM),
  [],
  'markdown',
);

/** The language a file is read in, by its name. */
function languageFor(path: string): Extension {
  if (/\.ya?ml$/i.test(path)) return yaml();
  if (/\.md$/i.test(path)) return yamlFrontmatter({ content: markdownShading });
  return [];
}

function extensionsFor(path: string, label: string, onChange: (text: string) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    undoHistory(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    languageFor(path),
    syntaxHighlighting(shading),
    look,
    flashField,
    problemLinesField,
    // ⌘S is the page's: it listens on the window, whatever has the keyboard.
    keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ 'aria-label': label }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.some((transaction) => transaction.annotation(fromOutside))) return;
      onChange(update.state.doc.toString());
    }),
  ];
}
