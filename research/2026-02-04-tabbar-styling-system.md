---
date: 2026-02-04T00:00:00-08:00
git_commit: 6aad0cdaa432713f57f7e081f7a3ce067e26e181
branch: feature/unified-markdown-support
repository: consola
topic: "TabBar Component Styling System"
tags: [research, codebase, css, tabbar, design-tokens]
status: complete
---

# Research: TabBar Component Styling System

**Date**: 2026-02-04
**Git Commit**: 6aad0cdaa432713f57f7e081f7a3ce067e26e181
**Branch**: feature/unified-markdown-support
**Repository**: consola

## Research Question

Research the TabBar component styling system thoroughly:
1. Find all CSS variables used and their values
2. Understand how the TabBar is positioned within its parent layout
3. Look at how other components handle hover borders
4. Understand the spacing system
5. Look at similar UI patterns

## Summary

The TabBar component is nested inside `.app-header-content` which has `padding: var(--space-2) var(--space-3)` (8px vertical, 12px horizontal). The header is 40px tall, and the tab items are 28px tall. The spacing system starts at `--space-1: 4px` and increments by 4px. **There is no `--space-0-5` variable** - the smallest spacing is `--space-1` (4px).

For borders, the codebase uses two established patterns:
1. **Change border-color on hover** (not add a border) - requires starting with `border: 1px solid transparent` or `border: 1px solid var(--color-border)`
2. **Use box-shadow for focus rings** - avoids layout shift entirely

---

## Detailed Findings

### 1. CSS Variables / Design Tokens

**Location:** `src/renderer/styles/themes/tokens.css`, `light.css`, `dark.css`

#### Spacing Variables
| Variable | Value |
|----------|-------|
| --space-1 | 4px |
| --space-2 | 8px |
| --space-3 | 12px |
| --space-4 | 16px |
| --space-5 | 20px |
| --space-6 | 24px |
| --space-7 | 28px |
| --space-8 | 32px |

**IMPORTANT:** There is NO `--space-0-5` or `--space-0` variable. The minimum spacing is 4px.

#### Border Radius Variables
| Variable | Value |
|----------|-------|
| --radius-sm | 3px |
| --radius-md | 6px |
| --radius-lg | 8px |
| --radius-full | 9999px |

#### Transition Variables
| Variable | Value |
|----------|-------|
| --transition-fast | 0.1s ease |
| --transition-normal | 0.2s ease |
| --transition-slow | 0.3s ease |

#### Border Color Variables
| Variable | Light Theme Value | Dark Theme Value |
|----------|-------------------|------------------|
| --color-border | rgba(55, 53, 47, 0.09) | rgba(255, 255, 255, 0.094) |
| --color-border-strong | rgba(55, 53, 47, 0.16) | rgba(255, 255, 255, 0.16) |

**Note:** There is a `--color-border-hover` variable used in some components but it may not be defined in the token files.

#### Background State Colors
| Variable | Light Theme Value | Dark Theme Value |
|----------|-------------------|------------------|
| --color-bg-hover | rgba(55, 53, 47, 0.04) | rgba(255, 255, 255, 0.055) |
| --color-bg-active | rgba(55, 53, 47, 0.08) | rgba(255, 255, 255, 0.09) |
| --color-bg-selected | rgba(35, 131, 226, 0.14) | rgba(35, 131, 226, 0.3) |

#### Layout Dimensions
| Variable | Value |
|----------|-------|
| --header-height | 40px |
| --sidebar-width | 240px |

---

### 2. TabBar Parent Layout Structure

```
Layout (div.layout)
  └── AppHeader (header.app-header) [height: 40px]
      ├── Drag Region
      ├── Sidebar Section (div.app-header-sidebar)
      └── Content Section (div.app-header-content) [padding: 8px 12px]
          └── TabBar (div.tab-bar) [height: 100%]
              └── Tab List (div.tab-list) [height: 100%]
                  └── TabItem(s) [height: 28px]
```

**Key constraints from `src/renderer/components/Layout/styles.css`:**

```css
.app-header {
  display: flex;
  height: var(--header-height);        /* 40px */
  min-height: var(--header-height);    /* 40px */
}

.app-header-content {
  flex: 1;
  display: flex;
  align-items: center;
  padding: var(--space-2) var(--space-3);  /* 8px 12px */
  background: var(--color-bg-primary);
  border-left: 1px solid var(--color-border);
}
```

**Available vertical space for tabs:**
- Header height: 40px
- Vertical padding: 8px top + 8px bottom = 16px
- Available: 40px - 16px = **24px**
- Current tab height: **28px** (4px taller than available space!)

This means tabs are being clipped or the container is overflowing slightly.

---

### 3. Border/Hover Patterns in Codebase

#### Pattern A: Border Color Change (NOT adding a border)

**Used in:** `src/renderer/components/Dialogs/styles.css:161-167`
```css
.dialog-button-secondary {
  border: 1px solid var(--color-border);  /* Always has border */
  transition: background var(--transition-fast),
              color var(--transition-fast),
              border-color var(--transition-fast);
}

.dialog-button-secondary:hover {
  border-color: var(--color-border-hover);  /* Changes color, not adds border */
}
```

**Used in:** `src/renderer/components/Views/styles.css:241-264`
```css
.settings-theme-button {
  border: 1px solid var(--color-border);  /* Always has border */
  transition: background var(--transition-fast),
              border-color var(--transition-fast),
              color var(--transition-fast);
}

.settings-theme-button.active {
  border-color: var(--color-accent);  /* Changes to accent color when active */
}
```

#### Pattern B: Box-Shadow for Focus (No Layout Shift)

**Used in:** `src/renderer/components/Dialogs/styles.css:107-112`
```css
.dialog-input:focus {
  box-shadow: 0 0 0 2px var(--color-accent-muted);  /* Ring effect */
}
```

#### Pattern C: Opacity Toggle for Conditional Elements

**Used in:** `src/renderer/components/TabBar/styles.css:79-84`
```css
.tab-item-close {
  opacity: 0;
  transition: background var(--transition-fast), opacity var(--transition-fast);
}

.tab-item:hover .tab-item-close {
  opacity: 1;
}
```

---

### 4. Similar UI Component Patterns

#### NavItem (Sidebar) - Most Similar Pattern
**File:** `src/renderer/components/Sidebar/styles.css:67-91`

```css
.nav-item {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);           /* 8px all around */
  border-radius: var(--radius-md);   /* 6px */
  background: transparent;
  color: var(--color-text-secondary);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.nav-item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.nav-item.active {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}
```

**Note:** NavItem does NOT use borders for hover/active states.

#### Settings Theme Button - Uses Border Pattern
**File:** `src/renderer/components/Views/styles.css:241-264`

```css
.settings-theme-button {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);      /* Has border by default */
  border-radius: var(--radius-md);
  background: transparent;
  transition: background var(--transition-fast),
              border-color var(--transition-fast),
              color var(--transition-fast);
}

.settings-theme-button:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.settings-theme-button.active {
  border-color: var(--color-accent);          /* Border color changes */
  background: var(--color-bg-selected);       /* Uses selected bg */
  color: var(--color-text-primary);
}
```

---

### 5. Current TabBar Styles

**File:** `src/renderer/components/TabBar/styles.css`

```css
.tab-list {
  display: flex;
  align-items: center;
  gap: var(--space-1);    /* 4px between tabs */
  height: 100%;
  overflow-x: auto;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);              /* 4px between icon/label/close */
  height: 28px;                      /* Fixed height */
  padding: 0 var(--space-2);         /* 0 8px - no vertical padding */
  border-radius: var(--radius-md);   /* 6px */
  background: transparent;
  color: var(--color-text-secondary);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.tab-item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.tab-item.active {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}
```

---

## Architecture Documentation

### Design System Patterns

1. **No borders on interactive items by default** - Most interactive items (nav items, tab items) use only background color changes for hover/active states, not borders.

2. **When borders are used, they exist in all states** - Components that use borders (like `.settings-theme-button`, `.dialog-button-secondary`) always have `border: 1px solid ...` in the base state. The hover/active states only change `border-color`, not add/remove the border.

3. **Consistent transition pattern** - All interactive elements use `transition: background var(--transition-fast), color var(--transition-fast)` with optional additional properties.

4. **Spacing system is in 4px increments** - There is no half-step (2px) spacing variable.

---

## Recommendations for TabBar Fix

Based on the research, to add subtle borders on hover/active:

1. **Add a transparent border to base state:**
```css
.tab-item {
  border: 1px solid transparent;
  /* ... existing styles ... */
  transition: background var(--transition-fast),
              color var(--transition-fast),
              border-color var(--transition-fast);
}
```

2. **Change border-color on hover/active:**
```css
.tab-item:hover {
  border-color: var(--color-border);  /* or --color-border-strong */
}

.tab-item.active {
  border-color: var(--color-border);
}
```

3. **For the gap issue**, the parent `.app-header-content` has `padding: var(--space-2) var(--space-3)` (8px 12px). This cannot be reduced using CSS variables since `--space-1` (4px) is the minimum. Options:
   - Use a hardcoded pixel value (breaks design system)
   - Accept the current spacing
   - Modify the parent padding in Layout/styles.css

4. **For right-aligning the close button**, use `margin-left: auto` on `.tab-item-close` instead of a fixed margin, which will push it to the right edge.

---

## Code References

- `src/renderer/components/TabBar/styles.css` - TabBar styles
- `src/renderer/components/TabBar/TabItem.tsx` - Tab item component
- `src/renderer/components/Layout/styles.css:46-57` - Parent container styles
- `src/renderer/styles/themes/tokens.css` - Design tokens
- `src/renderer/styles/themes/light.css` - Light theme colors
- `src/renderer/styles/themes/dark.css` - Dark theme colors
- `src/renderer/components/Views/styles.css:241-264` - Settings theme button (border pattern example)
- `src/renderer/components/Dialogs/styles.css:148-168` - Secondary button (border pattern example)
