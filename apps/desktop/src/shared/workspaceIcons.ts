/** Stable, persisted IDs; labels can change without changing workspace identity. */
export const WORKSPACE_SYMBOLS = [
  ['layout', 'Workspace'], ['briefcase', 'Briefcase'], ['home', 'Home'],
  ['code', 'Code'], ['terminal', 'Terminal'], ['rocket', 'Rocket'],
  ['flask', 'Experiments'], ['lightbulb', 'Ideas'], ['palette', 'Design'],
  ['book', 'Book'], ['graduation-cap', 'Learning'], ['globe', 'Globe'],
  ['heart', 'Heart'], ['star', 'Star'], ['zap', 'Lightning'],
  ['coffee', 'Coffee'], ['music', 'Music'], ['gamepad', 'Games'],
  ['camera', 'Camera'], ['compass', 'Compass'], ['mountain', 'Mountain'],
  ['leaf', 'Leaf'], ['sun', 'Sun'], ['moon', 'Moon'],
] as const;

export const WORKSPACE_EMOJIS = [
  ['emoji-rocket', 'Rocket', '🚀'], ['emoji-sparkles', 'Sparkles', '✨'],
  ['emoji-lightning', 'Lightning', '⚡'], ['emoji-fire', 'Fire', '🔥'],
  ['emoji-target', 'Target', '🎯'], ['emoji-brain', 'Brain', '🧠'],
  ['emoji-bulb', 'Ideas', '💡'], ['emoji-tools', 'Tools', '🛠️'],
  ['emoji-laptop', 'Laptop', '💻'], ['emoji-robot', 'Robot', '🤖'],
  ['emoji-flask', 'Experiments', '🧪'], ['emoji-palette', 'Design', '🎨'],
  ['emoji-books', 'Books', '📚'], ['emoji-note', 'Notes', '📝'],
  ['emoji-briefcase', 'Work', '💼'], ['emoji-house', 'Home', '🏡'],
  ['emoji-coffee', 'Coffee', '☕'], ['emoji-seedling', 'Seedling', '🌱'],
  ['emoji-tree', 'Tree', '🌲'], ['emoji-mountain', 'Mountain', '🏔️'],
  ['emoji-ocean', 'Ocean', '🌊'], ['emoji-sun', 'Sun', '☀️'],
  ['emoji-moon', 'Moon', '🌙'], ['emoji-globe', 'Globe', '🌍'],
  ['emoji-star', 'Star', '⭐'], ['emoji-heart', 'Heart', '❤️'],
  ['emoji-music', 'Music', '🎵'], ['emoji-gamepad', 'Games', '🎮'],
  ['emoji-cat', 'Cat', '🐱'], ['emoji-dog', 'Dog', '🐶'],
  ['emoji-fox', 'Fox', '🦊'], ['emoji-unicorn', 'Unicorn', '🦄'],
] as const;

export type WorkspaceSymbolId = (typeof WORKSPACE_SYMBOLS)[number][0];
export type WorkspaceIconId = WorkspaceSymbolId | (typeof WORKSPACE_EMOJIS)[number][0];

/** Uploaded images are resized PNGs, stored with the workspace so no source path is needed. */
export interface WorkspaceImageIcon {
  type: 'image';
  dataUrl: string;
}

export type WorkspaceIconValue = WorkspaceIconId | WorkspaceImageIcon;
export const WORKSPACE_ICON_IMAGE_SIZE = 128;
export const MAX_WORKSPACE_ICON_DATA_LENGTH = 100_000;

export function isWorkspaceImageIcon(value: unknown): value is WorkspaceImageIcon {
  if (!value || typeof value !== 'object') return false;
  const icon = value as Partial<WorkspaceImageIcon>;
  return icon.type === 'image' && typeof icon.dataUrl === 'string'
    && icon.dataUrl.length <= MAX_WORKSPACE_ICON_DATA_LENGTH
    && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$/.test(icon.dataUrl);
}

const iconIds = new Set<string>([...WORKSPACE_SYMBOLS, ...WORKSPACE_EMOJIS].map(([id]) => id));

export function isWorkspaceIconId(value: unknown): value is WorkspaceIconId {
  return typeof value === 'string' && iconIds.has(value);
}
