# Design

## Existing visual system

Consola uses React, Radix primitives, Lucide icons, and CSS theme tokens. Follow the selected light or dark theme; do not choose a new palette for a component interaction.

## Workspace navigation

The workspace rail is 56px wide. Workspace buttons are 34px square with 32px artwork and no tile background. A slim selection marker identifies the active workspace. Yellow is reserved for prompts requiring attention. Tooltips show the workspace name and compact modifier/number keycaps.

## Typography and spacing

Use the existing system font and semantic CSS variables. Tooltips use 12px labels; keyboard caps use 13px type. The base spacing scale is 4, 8, 12, and 16px. Keep the workspace rail's current density.

## Motion

For reordering, use a small lift, neighboring icons sliding into place, and a short settling transition. Animate transforms and opacity with 150–200ms exponential ease-out curves. Avoid bounce, sound, and decorative celebrations. Under reduced motion, preserve drag positioning and state feedback while disabling lift and settling animations.
