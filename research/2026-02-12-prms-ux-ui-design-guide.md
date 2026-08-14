# PRMS UX/UI Design Guide — Consola Integration

## Design Direction: "Developer Knowledge OS"

**Aesthetic**: Industrial-utilitarian meets editorial precision. Think Bloomberg Terminal's density married with Linear's polish. Every pixel earns its place. No decoration without function.

**Differentiator**: The PRMS doesn't look like Jira, Notion, or Linear. It looks like a *developer's private knowledge engine* — monospace ticket numbers feel like terminal output, status transitions feel like git operations, and the whole system breathes the same developer-native air as the existing conversation interface.

**One memorable thing**: The ticket number system. `PLAN-003` rendered in monospace with a subtle left-border accent feels like a commit SHA — native to developers, immediately scannable, never generic.

---

## 1. Navigation Integration

### Sidebar Addition

The "Plans & Research" entry sits between Home and Workspaces as a **first-class navigation category**, not a sub-item:

```
Sidebar
├── 🏠 Home                          ← existing
├── 📋 Plans & Research               ← NEW (collapsible)
│   ├── All Documents
│   ├── My Drafts (3)                 ← count badge
│   └── Recently Updated
├── ─── Workspaces ───                ← section divider
│   ├── console-1
│   └── api-server
└── ⚙️ Settings
```

**Design specifics:**

- Use `FileText` (Lucide) as the section icon — not a clipboard or kanban board
- The section header follows the existing `workspace-nav-item-container` pattern with `Collapsible.Root`
- Sub-items use the same `session-nav-item` sizing (12px font, 8px padding, 6px radius)
- "My Drafts" shows a **count badge** — a small monospace number in `--color-accent` background, 16px pill, matching the existing session-status-indicator sizing
- The divider between PRMS and Workspaces is a 1px `var(--color-border)` line with 8px vertical margin

### Active State

When a PRMS view is active:
- The sidebar item gets `var(--color-bg-active)` background
- `activeView` in navigationStore tracks `'plans-research' | 'document-detail' | null`
- MainContent switches based on `activeView` before falling through to workspace/session routing

---

## 2. Document Table View

### Layout

The table occupies the **full main content area** (no explorer panel, no preview panel). This is a focused data view:

```
┌─ Main Content ──────────────────────────────────────────────────┐
│                                                                  │
│  Plans & Research                                    [+ New ▾]  │
│                                                                  │
│  ┌─ Filter Bar ──────────────────────────────────────────────┐  │
│  │ 🔍 Search...  [Type ▾] [Status ▾] [Priority ▾] [Tags ▾] │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─ Table ───────────────────────────────────────────────────┐  │
│  │ # ▾     Title              Type  Status    Tasks  Updated │  │
│  │─────────────────────────────────────────────────────────── │  │
│  │ PLAN-003 Auth System Design  📋   ● Active   4/12  2m     │  │
│  │ RES-042  SDK Interop Study   📄   ● Done     —     1d     │  │
│  │ PLAN-002 Git Integration     📋   ○ Draft    0/8   3d     │  │
│  │                                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  Showing 12 documents                                           │
└──────────────────────────────────────────────────────────────────┘
```

### Component-Level Design

#### Table Header Row
- **Font**: `var(--font-size-xs)` (11px), `var(--font-weight-medium)`, `var(--color-text-tertiary)`
- **Text transform**: uppercase, `letter-spacing: 0.05em` — matches the existing sidebar section headers
- **Sort indicator**: Small chevron (10px) next to active sort column, rotates on direction change
- **Sticky**: `position: sticky; top: 0; z-index: 1` with `var(--color-bg-primary)` background + subtle bottom border

#### Table Rows
- **Height**: 40px (compact but touchable)
- **Padding**: `0 var(--space-4)` (16px horizontal)
- **Border**: `1px solid var(--color-border)` bottom only — no vertical borders
- **Hover**: `var(--color-bg-hover)` background, entire row clickable
- **Active/Selected**: `var(--color-bg-selected)` background with 2px left border in `var(--color-accent)`
- **Transition**: `background var(--transition-fast)`

#### Ticket Number Column
```css
.document-ticket {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs); /* 11px */
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.document-ticket:hover {
  color: var(--color-accent);
}
```

This is the **signature element** — monospace ticket numbers immediately signal "this is a structured system" without looking corporate.

#### Title Column
- **Font**: `var(--font-size-sm)` (12px), `var(--font-weight-medium)`, `var(--color-text-primary)`
- **Overflow**: `text-overflow: ellipsis` with title tooltip
- **Flex**: Takes remaining space (`flex: 1`)

#### Type Badge
Two variants, minimal:
```css
.type-badge {
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-weight: var(--font-weight-medium);
}

.type-badge--plan {
  color: var(--color-accent);
  background: rgba(35, 131, 226, 0.08);
}

.type-badge--research {
  color: var(--color-info);
  background: rgba(86, 182, 194, 0.08);
}
```

#### Status Indicator
A **small dot + label** pattern (matching the existing session-status-indicator):

```css
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

/* Status colors */
.status-dot--draft     { background: var(--gray-8); }
.status-dot--review    { background: var(--color-warning); }
.status-dot--approved  { background: var(--color-accent); }
.status-dot--active    { background: var(--color-success); animation: pulse-indicator 1.5s ease-in-out infinite; }
.status-dot--completed { background: var(--color-success); }
.status-dot--archived  { background: var(--gray-6); }
```

#### Task Progress
A **fraction + micro progress bar**:
```css
.task-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.task-progress-bar {
  width: 32px;
  height: 2px;
  background: var(--color-border);
  border-radius: 1px;
  overflow: hidden;
}

.task-progress-fill {
  height: 100%;
  background: var(--color-success);
  transition: width 400ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

#### Relative Timestamps
- `var(--font-size-xs)`, `var(--color-text-tertiary)`
- Format: "2m", "1h", "3d", "1w", "2mo" — ultra-compact
- Tooltip shows full date on hover

### Filter Bar

Sits between the header and table, always visible:

```css
.filter-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border);
}
```

- **Search input**: Inline, no border, just a `Search` icon (14px) + placeholder text. Expands on focus.
- **Filter dropdowns**: Use Radix `DropdownMenu` with the existing `.dropdown-content` styling. Trigger buttons are ghost-style pills:

```css
.filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  background: transparent;
  border: 1px solid transparent;
  transition: all var(--transition-fast);
}

.filter-pill:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-border);
}

.filter-pill.active {
  background: var(--color-bg-active);
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}
```

### "New" Button

Top-right, a dropdown trigger:
```
[+ New ▾]
  ├── New Plan
  └── New Research
```

Uses the existing DropdownMenu pattern. Primary accent color for the trigger, ghost style.

### Empty State

When no documents exist:
```
┌──────────────────────────────────────┐
│                                      │
│          📋                          │
│                                      │
│    No plans or research yet          │
│    Create your first document to     │
│    start organizing your work.       │
│                                      │
│    [+ New Plan]  [+ New Research]    │
│                                      │
└──────────────────────────────────────┘
```

Follows the existing HomeView pattern: centered icon (48px), tertiary text, accent-colored CTA buttons.

---

## 3. Document Detail View

### Layout Strategy

The detail view replaces the main content area with a **two-zone layout**:

```
┌─ Header Zone ─────────────────────────────────────────────────┐
│ ← Back    PLAN-003  Auth System Design       [Edit] [Status ▾]│
│ Tags: [auth] [security] [+]    v3 · Feb 12    By Javier      │
└───────────────────────────────────────────────────────────────┘
┌─ Content Zone ─────────────────────────────────────────────────┐
│ ┌─ Tab Bar ─────────────────────────────────────────────────┐ │
│ │ Content │ Tasks (4/12) │ Comments (3) │ History │ Activity │ │
│ └─────────────────────────────────────────────────────────── ┘ │
│                                                                │
│  [Active tab content rendered here]                            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Header Zone

```css
.document-header {
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.document-header-top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
```

**Back button**: `ArrowLeft` icon (16px) + "Back" text, ghost button, navigates to table
**Ticket number**: Monospace, `var(--color-text-tertiary)`, 11px — acts as a persistent identifier
**Title**: `var(--font-size-lg)` (16px), `var(--font-weight-semibold)`, `var(--color-text-primary)`
**Edit button**: Ghost button with `Pencil` icon, 14px
**Status dropdown**: Uses existing DropdownMenu pattern, colored dot + label

**Second row (metadata)**:
- Tags rendered as pills (same as filter pills but smaller, 10px font)
- Version number in monospace
- Author name
- Relative timestamp

### Tab Bar

Uses Radix `Tabs.Root` + `Tabs.List` + `Tabs.Content`:

```css
.document-tabs-list {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
  padding: 0 var(--space-4);
}

.document-tab-trigger {
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  transition: all var(--transition-fast);
}

.document-tab-trigger:hover {
  color: var(--color-text-primary);
}

.document-tab-trigger[data-state='active'] {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-accent);
}
```

Count badges inside tabs:
```css
.tab-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-tertiary);
  margin-left: 4px;
}
```

### Content Tab

Rendered markdown using the existing `MarkdownRenderer` component. Full width, comfortable reading:

```css
.document-content-body {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--space-5);
  line-height: var(--line-height-relaxed);
}
```

### Priority Indicator

Appears in the header as a subtle left-border accent:

```css
.document-header--critical { border-left: 3px solid var(--color-error); }
.document-header--high     { border-left: 3px solid var(--color-warning); }
.document-header--medium   { border-left: 3px solid var(--color-accent); }
.document-header--low      { border-left: 3px solid var(--gray-6); }
```

This is borrowed from the existing `approval-card` pattern which uses a colored left status line.

---

## 4. Document Editor

### Layout

Split-pane editor using `react-resizable-panels` (already in deps):

```
┌─ Editor Header ───────────────────────────────────────────────┐
│ ← Back    Editing PLAN-003        Draft · Saved 5s ago        │
│                                   [Discard] [Publish v4]      │
└───────────────────────────────────────────────────────────────┘
┌─ Split Pane ──────────────────────────────────────────────────┐
│ ┌─ Editor (50%) ──────── │ ──── Preview (50%) ─────────────┐ │
│ │                        │                                   │ │
│ │  ## Overview           │  **Overview**                     │ │
│ │  This plan outlines... │  This plan outlines...            │ │
│ │                        │                                   │ │
│ │                        │                                   │ │
│ └───────────���────────────│───────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
┌─ Footer ──────────────────────────────────────────────────────┐
│ Change description: [What changed in this version?       ]    │
└───────────────────────────────────────────────────────────────┘
```

### Key Design Details

**Auto-save indicator** (top right):
```css
.auto-save-indicator {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.auto-save-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color-success);
  animation: save-pulse 1s ease-out; /* one-shot on save */
}
```

States: "Draft", "Saving...", "Saved 5s ago", "Unsaved changes"

**Editor pane**:
- Plain textarea with `var(--font-mono)`, `var(--font-size-sm)` (12px)
- Line numbers on the left (optional toggle)
- Background: `var(--color-bg-primary)`
- No syntax highlighting for markdown — keep it raw and fast

**Preview pane**:
- Uses existing `MarkdownRenderer`
- Background: `var(--color-bg-secondary)` — subtle differentiation
- Synced scroll (scroll position linked between panes)

**Publish button**:
```css
.publish-button {
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  padding: 6px 12px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.publish-button:hover {
  background: var(--color-accent-hover);
}
```

**Discard button**: Ghost style, `var(--color-text-secondary)`, subtle.

**Change description field** (bottom):
- Single-line input
- `var(--font-size-sm)`, placeholder: "What changed in this version?"
- Required before publish (subtle red border if empty on publish attempt)

---

## 5. Task Breakdown Panel

### Within Document Detail "Tasks" Tab

```
┌─────────────────────────────────────────────────────────────────┐
│ Tasks · 4/12                      [+ Add] [🤖 AI Generate]     │
│ ┌─ Progress ──────────────────────────────────────────────────┐ │
│ │ ████████░░░░░░░░░░░░░░░░░░░░░░░ 33%                       │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ≡ TASK-001  Set up auth middleware           [In Progress ▾] ●  │
│   ≡ TASK-002  Install passport.js            [Done ▾]       ↗  │
│   ≡ TASK-003  Configure JWT strategy         [Done ▾]       ↗  │
│                                                                  │
│ ≡ TASK-004  Create login endpoint            [Todo ▾]        ●  │
│                                                                  │
│ ≡ TASK-005  Create registration endpoint     [Backlog ▾]     ●  │
│                                                                  │
│ ≡ TASK-006  Add integration tests            [Backlog ▾]     ●  │
│                                                                  │
│ ─── Completed (4) ──────────────────────────────────────── ▾ ── │
│ ✓ TASK-007  Research JWT libraries                              │
│ ✓ TASK-008  Design database schema                              │
│ ✓ TASK-009  Set up test harness                                 │
│ ✓ TASK-010  Review security requirements                        │
└─────────────────────────────────────────────────────────────────┘
```

### Task Item Design

```css
.task-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
  cursor: grab;
}

.task-item:hover {
  background: var(--color-bg-hover);
}

.task-item.dragging {
  opacity: 0.5;
  background: var(--color-bg-active);
}
```

**Drag handle**: `GripVertical` icon (12px), `var(--color-text-disabled)`, appears on hover
**Ticket number**: Monospace, 10px, `var(--color-text-tertiary)` — compact
**Title**: `var(--font-size-sm)`, inline editable (click to edit, Enter to save)
**Status dropdown**: Compact Radix DropdownMenu, colored dot + label

**Sub-task indentation**: 24px left padding per level, with a subtle 1px left border in `var(--color-border)`

**External sync badge**:
```css
.sync-badge {
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--color-text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.sync-badge--synced   { color: var(--color-success); }
.sync-badge--pending  { color: var(--color-warning); }
.sync-badge--error    { color: var(--color-error); }

.sync-badge a {
  text-decoration: none;
  color: inherit;
}

.sync-badge a:hover {
  color: var(--color-accent);
  text-decoration: underline;
}
```

### AI Generate Button

A distinctive interaction — the "AI Generate" button triggers Claude to analyze the plan and suggest tasks:

```css
.ai-generate-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--color-accent);
  background: rgba(35, 131, 226, 0.06);
  border: 1px solid rgba(35, 131, 226, 0.12);
  transition: all var(--transition-fast);
}

.ai-generate-btn:hover {
  background: rgba(35, 131, 226, 0.12);
  border-color: rgba(35, 131, 226, 0.24);
}

.ai-generate-btn.generating {
  pointer-events: none;
}

.ai-generate-btn.generating .ai-generate-icon {
  animation: todo-spin 0.8s linear infinite;
}
```

Uses `Sparkles` icon (14px) from Lucide — matches the existing HomeView sparkles pattern.

### Completed Section

Collapsible using Radix `Collapsible.Root`:
- Collapsed by default when > 3 completed tasks
- Header: "Completed (4)" in tertiary text with chevron
- Items at 55% opacity (matching the existing `todo-item.completed` pattern)

---

## 6. Comments Panel

### Within Document Detail "Comments" Tab

```
┌─────────────────────────────────────────────────────────────────┐
│ Comments (3)                                                     │
│                                                                  │
│ ┌─ Comment ──────────────────────────────────────────────────┐  │
│ │ JT  Javier Taraza · 2h ago                      [Resolve] │  │
│ │                                                             │  │
│ │ Consider adding rate limiting to the login endpoint.       │  │
│ │ We should also think about brute force protection.         │  │
│ │                                                             │  │
│ │   ┌─ Reply ─────────────────────────────────────────────┐  │  │
│ │   │ JT  Javier Taraza · 1h ago                          │  │  │
│ │   │ Good point — I'll add a task for this.              │  │  │
│ │   └─────────────────────────────────────────────────────┘  │  │
│ │                                                             │  │
│ │ [Reply]                                                     │  │
│ └─────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌─ Add Comment ──────────────────────────────────────────────┐  │
│ │ Write a comment...                              [Comment]  │  │
│ └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Comment Design

```css
.comment-item {
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
}

.comment-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: 9px;
  font-weight: var(--font-weight-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.comment-resolved {
  opacity: 0.5;
  border-left: 2px solid var(--color-success);
}
```

Replies nested with 24px left indentation, lighter border color.

---

## 7. Version History Tab

### Timeline Design

```css
.version-timeline {
  padding: var(--space-4);
}

.version-item {
  display: flex;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  position: relative;
}

/* Vertical connecting line */
.version-item:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 24px;
  bottom: 0;
  width: 1px;
  background: var(--color-border);
}

.version-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
  margin-top: 6px;
  flex-shrink: 0;
}

.version-dot--current {
  width: 10px;
  height: 10px;
  box-shadow: 0 0 0 3px rgba(35, 131, 226, 0.2);
}
```

---

## 8. Global Search (Cmd+K)

### Command Palette Design

```css
.search-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: var(--z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 120px;
}

.search-palette {
  width: 560px;
  max-height: 480px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-elevation-2);
  overflow: hidden;
  animation: palette-enter 150ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes palette-enter {
  from {
    opacity: 0;
    transform: scale(0.98) translateY(-8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
```

Categories rendered with uppercase section headers (matching sidebar section header style). Results use keyboard navigation (↑↓ Enter Esc).

---

## 9. Innovative UX Ideas

### 9.1 "Create from Conversation" Flow

When Claude generates a plan in conversation, show a floating action button:

```
┌─ Assistant Message ──────────────────────────────────┐
│                                          [📋 Save as Plan]│
│ ## Authentication System Plan                            │
│ Based on our discussion...                               │
└──────────────────────────────────────────────────────────┘
```

### 9.2 Status Transition Animations

```css
.status-dot.transitioning {
  animation: status-morph 600ms ease;
}

@keyframes status-morph {
  0% { transform: scale(1); }
  30% { transform: scale(1.4); box-shadow: 0 0 0 4px var(--color-bg-selected); }
  100% { transform: scale(1); }
}
```

### 9.3 Keyboard-First Interactions

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Global search |
| `Cmd+N` | New document |
| `Cmd+E` | Toggle edit mode |
| `Cmd+S` | Publish draft |
| `Space` | Toggle task status |

---

## 10. Theme Consistency Checklist

- [ ] `var(--color-bg-*)` for backgrounds
- [ ] `var(--color-text-*)` for text hierarchy
- [ ] `var(--color-border)` / `var(--color-border-strong)` for borders
- [ ] `var(--color-accent)` for primary actions
- [ ] `var(--font-mono)` for ticket numbers and data
- [ ] `var(--font-size-xs)` (11px) for badges/metadata
- [ ] `var(--radius-sm)` / `var(--radius-md)` for elements
- [ ] `var(--space-*)` for all spacing
- [ ] `var(--transition-fast)` for interactions
- [ ] Both `[data-theme='light']` and `[data-theme='dark']` tested
- [ ] Hover, active, focus, disabled states on all interactive elements
- [ ] Radix UI primitives for all dropdowns, tooltips, dialogs
- [ ] Lucide React icons at 12-16px consistent sizes
