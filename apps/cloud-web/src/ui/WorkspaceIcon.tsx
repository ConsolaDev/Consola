import {
  BookOpen,
  Briefcase,
  Camera,
  Code,
  Coffee,
  Compass,
  FlaskConical,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Lightbulb,
  type LucideIcon,
  Moon,
  Mountain,
  Music,
  Palette,
  PanelsTopLeft,
  Rocket,
  Star,
  Sun,
  Terminal,
  Zap,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import {
  emojiOf,
  type WorkspaceIcon as Icon,
  type WorkspaceSymbol,
  workspaceInitial,
} from '../domain/workspaceIcons';

/** Each symbol as the desktop app draws it (`components/WorkspaceIcon.tsx`), from the same set. */
const SYMBOLS: Record<WorkspaceSymbol, LucideIcon> = {
  layout: PanelsTopLeft,
  briefcase: Briefcase,
  home: House,
  code: Code,
  terminal: Terminal,
  rocket: Rocket,
  flask: FlaskConical,
  lightbulb: Lightbulb,
  palette: Palette,
  book: BookOpen,
  'graduation-cap': GraduationCap,
  globe: Globe,
  heart: Heart,
  star: Star,
  zap: Zap,
  coffee: Coffee,
  music: Music,
  gamepad: Gamepad2,
  camera: Camera,
  compass: Compass,
  mountain: Mountain,
  leaf: Leaf,
  sun: Sun,
  moon: Moon,
};

/**
 * A workspace's icon, as the desktop app draws it: its symbol or its emoji at `size`, or, with
 * no icon, its initial on a rounded tile. It says nothing to a screen reader: the workspace's
 * name is always written beside it, and a picker names each choice itself.
 */
export function WorkspaceIcon({
  icon,
  name = '',
  size,
}: {
  icon: Icon | null;
  name?: string;
  size: number;
}) {
  const emoji = icon ? emojiOf(icon) : null;
  const style = { '--workspace-icon-size': `${size}px` } as CSSProperties;

  if (icon === null) {
    return (
      <span className="workspace-icon" data-kind="initial" style={style} aria-hidden="true">
        {workspaceInitial(name)}
      </span>
    );
  }
  if (emoji) {
    return (
      <span className="workspace-icon" data-kind="emoji" style={style} aria-hidden="true">
        {emoji}
      </span>
    );
  }
  const Drawn = SYMBOLS[icon as WorkspaceSymbol];
  return (
    <span className="workspace-icon" data-kind="symbol" style={style} aria-hidden="true">
      <Drawn size={size} />
    </span>
  );
}
