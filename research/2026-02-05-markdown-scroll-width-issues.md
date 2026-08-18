---
date: 2026-02-05T10:30:00+01:00
git_commit: 61c88466c73f4f9da316b7b702740c88f19c2072
branch: main
repository: console-1
topic: "Markdown Preview Scrolling and Width Issues"
tags: [research, codebase, scrolling, css, radix-ui, layout]
status: complete
---

# Research: Markdown Preview Scrolling and Width Issues

**Date**: 2026-02-05T10:30:00+01:00
**Git Commit**: 61c88466c73f4f9da316b7b702740c88f19c2072
**Branch**: main
**Repository**: console-1

## Research Question

In the current markdown raw support implementation, there are 2 main issues:
1. Vertical scrolling does not work in either preview or raw mode
2. Content does not adapt to the actual width of the screen in either mode

## Summary

The root causes have been identified:

1. **Scrolling Issue**: The Radix UI `ScrollArea` component is not receiving proper height constraints from its parent. While `.markdown-view-content-wrapper` has `flex: 1` and `min-height: 0`, the **ScrollArea itself is missing explicit height constraints** that Radix UI requires.

2. **Width Issue**: The content inside ScrollArea is not being constrained to the viewport width. The `.markdown-view-panel` and SyntaxHighlighter content can grow beyond the ScrollArea bounds.

## Detailed Findings

### Container Hierarchy

```
.preview-panel (height: 100%, flex column)
  └── .preview-panel-content (flex: 1, overflow: hidden)  ← MISSING min-height: 0
      └── .markdown-file-view (height: 100%, flex column)
          └── .markdown-view-toggle-bar (fixed height ~40px)
          └── .markdown-view-content-wrapper (flex: 1, overflow: hidden, min-height: 0)
              └── ScrollArea.file-content (flex: 1, overflow: auto, height: 100%, width: 100%)
                  └── .markdown-view-panel / .markdown-source-view (content)
```

### Issue 1: Vertical Scrolling Not Working

**Root Cause**: Multiple contributing factors:

1. **`.preview-panel-content` is missing `min-height: 0`** (`styles.css:125-128`)
   - This class has `flex: 1` but no `min-height: 0`
   - In flexbox, children default to `min-height: auto`, preventing shrinking below content size
   - This breaks the height constraint chain

2. **ScrollArea internal structure** - Radix UI's ScrollArea creates:
   ```html
   <div class="rt-ScrollAreaRoot">     <!-- needs height constraint -->
     <div class="rt-ScrollAreaViewport">  <!-- inherits 100% from root -->
       {children}
     </div>
   </div>
   ```
   The `.file-content` class applies styles to the Root, but if the parent container (`markdown-view-content-wrapper`) doesn't properly constrain height due to the broken flex chain, ScrollArea can't calculate overflow.

**CSS Chain Analysis:**
```css
/* PreviewPanel/styles.css:125-128 */
.preview-panel-content {
  flex: 1;
  overflow: hidden;
  /* MISSING: min-height: 0; */
}

/* Views/styles.css:463-468 */
.markdown-view-content-wrapper {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-height: 0; /* Has this, but parent doesn't */
}

/* Views/styles.css:223-228 */
.file-content {
  flex: 1;
  overflow: auto;
  height: 100%;
  width: 100%;
}
```

### Issue 2: Content Not Adapting to Screen Width

**Root Cause**: Multiple factors:

1. **`.markdown-view-panel` has `width: 100%` but is inside ScrollArea**
   - ScrollArea's viewport uses `width: fit-content` for children by default
   - This allows content to expand beyond the visible area

2. **SyntaxHighlighter in source view** (`MarkdownFileView.tsx:93-111`)
   - The `customStyle` sets `minHeight: '100%'` but no width constraint
   - Code blocks can be arbitrarily wide

3. **`.markdown-source-view pre` has `max-width: 100%`** but this is relative to its container, which may not be constrained

**CSS for content panels:**
```css
/* Views/styles.css:470-477 */
.markdown-view-panel {
  animation: markdown-view-fade-in 0.2s ease;
  width: 100%;              /* 100% of what? */
  box-sizing: border-box;
  overflow-x: hidden;       /* Clips overflow but doesn't constrain width */
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* Views/styles.css:496-500 */
.markdown-source-view pre {
  margin: 0 !important;
  max-width: 100%;          /* 100% of unconstrained parent */
  overflow-x: auto;
}
```

### Comparison with Working Implementations

**AgentPanel** uses native scrolling successfully:
```css
/* Agent/styles.css:14-19 */
.messages-container {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2);
}
```
Key difference: No Radix ScrollArea - uses simple native overflow.

**CodeFileView** also works:
```css
/* Views/styles.css:381-389 */
.code-file-content {
  flex: 1;
  overflow: auto;
}
```
Key difference: Also uses native scrolling, not Radix ScrollArea.

## Code References

- `src/renderer/components/Views/MarkdownFileView.tsx:56-117` - Main component structure
- `src/renderer/components/Views/MarkdownFileView.tsx:86` - ScrollArea usage
- `src/renderer/components/Views/styles.css:223-228` - `.file-content` styles
- `src/renderer/components/Views/styles.css:463-468` - `.markdown-view-content-wrapper` styles
- `src/renderer/components/Views/styles.css:470-477` - `.markdown-view-panel` styles
- `src/renderer/components/PreviewPanel/styles.css:125-128` - `.preview-panel-content` (missing min-height: 0)
- `src/renderer/components/PreviewPanel/PreviewPanel.tsx:48` - Parent container structure

## Proposed Fix

### Option A: Fix CSS constraints (Recommended)

**1. Add `min-height: 0` to `.preview-panel-content`:**

```css
/* PreviewPanel/styles.css */
.preview-panel-content {
  flex: 1;
  overflow: hidden;
  min-height: 0;  /* ADD THIS */
}
```

**2. Ensure ScrollArea has explicit height:**

```css
/* Views/styles.css */
.file-content {
  flex: 1;
  overflow: auto;
  height: 100%;
  width: 100%;
  min-height: 0;  /* ADD THIS - belt and suspenders */
}
```

**3. Constrain content width by targeting ScrollArea viewport:**

```css
/* Views/styles.css - ADD */
.file-content [data-radix-scroll-area-viewport] > div {
  width: 100% !important;  /* Override fit-content */
}

.markdown-view-panel {
  width: 100%;
  max-width: 100%;  /* ADD THIS */
  box-sizing: border-box;
  overflow-x: hidden;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
```

### Option B: Replace ScrollArea with native scrolling

Since CodeFileView and AgentPanel successfully use native scrolling, consider:

```tsx
// Instead of:
<ScrollArea className="file-content">
  {content}
</ScrollArea>

// Use:
<div className="file-content">
  {content}
</div>
```

This avoids Radix ScrollArea's complexity and is consistent with other views.

## Architecture Documentation

The application uses a nested flex layout:
- `react-resizable-panels` provides the panel structure
- Each panel contains a flex column layout
- Content areas use either Radix ScrollArea or native `overflow: auto`
- The flex chain requires `min-height: 0` at each level to allow shrinking

The MarkdownFileView is the only component using Radix ScrollArea, making it the only one with these issues.

## Open Questions

1. Why was Radix ScrollArea chosen for MarkdownFileView instead of native scrolling?
2. Are there specific features of ScrollArea (custom scrollbars, etc.) that are needed?
3. Should we standardize on native scrolling across all views for consistency?
