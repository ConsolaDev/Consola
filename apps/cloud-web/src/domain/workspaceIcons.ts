import type { components } from './apiContract';

/**
 * The icons a workspace can wear, as the desktop app offers them (its
 * `shared/workspaceIcons.ts`): symbols, each drawn from the desktop's icon set by the screen
 * (`ui/WorkspaceIcon.tsx`), and emoji. The ids are the API's (`MyWorkspace.icon`), which
 * cloud-global keeps equal to the desktop's; `workspaceIcons.test.ts` checks this copy holds
 * exactly those. A label is what the picker searches and a screen reader hears.
 */
export type WorkspaceIcon = NonNullable<components['schemas']['MyWorkspace']['icon']>;

export const WORKSPACE_SYMBOLS = [
  ['layout', 'Workspace'],
  ['briefcase', 'Briefcase'],
  ['home', 'Home'],
  ['code', 'Code'],
  ['terminal', 'Terminal'],
  ['rocket', 'Rocket'],
  ['flask', 'Experiments'],
  ['lightbulb', 'Ideas'],
  ['palette', 'Design'],
  ['book', 'Book'],
  ['graduation-cap', 'Learning'],
  ['globe', 'Globe'],
  ['heart', 'Heart'],
  ['star', 'Star'],
  ['zap', 'Lightning'],
  ['coffee', 'Coffee'],
  ['music', 'Music'],
  ['gamepad', 'Games'],
  ['camera', 'Camera'],
  ['compass', 'Compass'],
  ['mountain', 'Mountain'],
  ['leaf', 'Leaf'],
  ['sun', 'Sun'],
  ['moon', 'Moon'],
] as const satisfies readonly (readonly [WorkspaceIcon, string])[];

export const WORKSPACE_EMOJIS = [
  ['emoji-rocket', 'Rocket', '🚀'],
  ['emoji-sparkles', 'Sparkles', '✨'],
  ['emoji-lightning', 'Lightning', '⚡'],
  ['emoji-fire', 'Fire', '🔥'],
  ['emoji-target', 'Target', '🎯'],
  ['emoji-brain', 'Brain', '🧠'],
  ['emoji-bulb', 'Ideas', '💡'],
  ['emoji-tools', 'Tools', '🛠️'],
  ['emoji-laptop', 'Laptop', '💻'],
  ['emoji-robot', 'Robot', '🤖'],
  ['emoji-flask', 'Experiments', '🧪'],
  ['emoji-palette', 'Design', '🎨'],
  ['emoji-books', 'Books', '📚'],
  ['emoji-note', 'Notes', '📝'],
  ['emoji-briefcase', 'Work', '💼'],
  ['emoji-house', 'Home', '🏡'],
  ['emoji-coffee', 'Coffee', '☕'],
  ['emoji-seedling', 'Seedling', '🌱'],
  ['emoji-tree', 'Tree', '🌲'],
  ['emoji-mountain', 'Mountain', '🏔️'],
  ['emoji-ocean', 'Ocean', '🌊'],
  ['emoji-sun', 'Sun', '☀️'],
  ['emoji-moon', 'Moon', '🌙'],
  ['emoji-globe', 'Globe', '🌍'],
  ['emoji-star', 'Star', '⭐'],
  ['emoji-heart', 'Heart', '❤️'],
  ['emoji-music', 'Music', '🎵'],
  ['emoji-gamepad', 'Games', '🎮'],
  ['emoji-cat', 'Cat', '🐱'],
  ['emoji-dog', 'Dog', '🐶'],
  ['emoji-fox', 'Fox', '🦊'],
  ['emoji-unicorn', 'Unicorn', '🦄'],
] as const satisfies readonly (readonly [WorkspaceIcon, string, string])[];

export type WorkspaceSymbol = (typeof WORKSPACE_SYMBOLS)[number][0];

/** The emoji an icon id stands for, or null when it is a symbol. */
export function emojiOf(icon: WorkspaceIcon): string | null {
  return WORKSPACE_EMOJIS.find(([id]) => id === icon)?.[2] ?? null;
}

/** What an icon is called, for the picker's search and a screen reader. */
export function iconLabel(icon: WorkspaceIcon): string {
  return [...WORKSPACE_SYMBOLS, ...WORKSPACE_EMOJIS].find(([id]) => id === icon)?.[1] ?? icon;
}

/**
 * The choices among `icons` whose label holds `query`, ignoring case and the spaces around it;
 * every one for an empty query.
 */
export function iconsMatching<Choice extends readonly [WorkspaceIcon, string, ...string[]]>(
  icons: readonly Choice[],
  query: string,
): Choice[] {
  const wanted = query.trim().toLowerCase();
  return icons.filter(([, label]) => label.toLowerCase().includes(wanted));
}

/** What stands in for a workspace with no icon: its name's first letter, capitalised. */
export function workspaceInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?';
}

/** What the API answered a request to set or clear the active workspace's icon. */
export type SetIconAnswer =
  | { kind: 'changed'; workspace: components['schemas']['MyWorkspace'] }
  | { kind: 'not-allowed' }
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
