/**
 * The icons a workspace can wear: a symbol, or an emoji. The ids are the desktop app's own
 * (`apps/desktop/src/shared/workspaceIcons.ts`, symbols first, then `emoji-…`), so a workspace
 * known to both shows the same icon in each; a label or a glyph is each client's to draw. An id
 * never changes once a workspace may hold it. No icon (null) is the workspace's initial.
 */
export const WORKSPACE_ICONS = [
  'layout',
  'briefcase',
  'home',
  'code',
  'terminal',
  'rocket',
  'flask',
  'lightbulb',
  'palette',
  'book',
  'graduation-cap',
  'globe',
  'heart',
  'star',
  'zap',
  'coffee',
  'music',
  'gamepad',
  'camera',
  'compass',
  'mountain',
  'leaf',
  'sun',
  'moon',
  'emoji-rocket',
  'emoji-sparkles',
  'emoji-lightning',
  'emoji-fire',
  'emoji-target',
  'emoji-brain',
  'emoji-bulb',
  'emoji-tools',
  'emoji-laptop',
  'emoji-robot',
  'emoji-flask',
  'emoji-palette',
  'emoji-books',
  'emoji-note',
  'emoji-briefcase',
  'emoji-house',
  'emoji-coffee',
  'emoji-seedling',
  'emoji-tree',
  'emoji-mountain',
  'emoji-ocean',
  'emoji-sun',
  'emoji-moon',
  'emoji-globe',
  'emoji-star',
  'emoji-heart',
  'emoji-music',
  'emoji-gamepad',
  'emoji-cat',
  'emoji-dog',
  'emoji-fox',
  'emoji-unicorn',
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];

export function isWorkspaceIcon(value: unknown): value is WorkspaceIcon {
  return WORKSPACE_ICONS.some((icon) => icon === value);
}

/**
 * Whether a request's icon can be set: one of `WORKSPACE_ICONS`, or null for none. Anything else,
 * an empty string included, is `icon_unknown`.
 */
export function checkWorkspaceIcon(
  value: unknown,
): { ok: true; icon: WorkspaceIcon | null } | { ok: false; problem: 'icon_unknown' } {
  if (value === null) return { ok: true, icon: null };
  if (isWorkspaceIcon(value)) return { ok: true, icon: value };
  return { ok: false, problem: 'icon_unknown' };
}
