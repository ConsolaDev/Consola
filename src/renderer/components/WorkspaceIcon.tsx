import { useState } from 'react';
import {
  PanelsTopLeft, Briefcase, House, Code, Terminal, Rocket, FlaskConical,
  Lightbulb, Palette, BookOpen, GraduationCap, Globe, Heart, Star, Zap,
  Coffee, Music, Gamepad2, Camera, Compass, Mountain, Leaf, Sun, Moon,
  type LucideIcon,
} from 'lucide-react';
import {
  WORKSPACE_EMOJIS, isWorkspaceImageIcon, type WorkspaceIconValue, type WorkspaceSymbolId,
} from '../../shared/workspaceIcons';

const SYMBOLS: Record<WorkspaceSymbolId, LucideIcon> = {
  layout: PanelsTopLeft, briefcase: Briefcase, home: House, code: Code,
  terminal: Terminal, rocket: Rocket, flask: FlaskConical, lightbulb: Lightbulb,
  palette: Palette, book: BookOpen, 'graduation-cap': GraduationCap,
  globe: Globe, heart: Heart, star: Star, zap: Zap, coffee: Coffee,
  music: Music, gamepad: Gamepad2, camera: Camera, compass: Compass,
  mountain: Mountain, leaf: Leaf, sun: Sun, moon: Moon,
};

/** A workspace's identity, independent of its scopes and their repository status. */
export function WorkspaceIcon({
  icon, size = 16, className,
}: { icon?: WorkspaceIconValue; size?: number; className?: string }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = isWorkspaceImageIcon(icon) && icon.dataUrl !== failedImage ? icon : undefined;
  const emoji = WORKSPACE_EMOJIS.find(([id]) => id === icon)?.[2];
  const hasSymbol = typeof icon === 'string' && Object.prototype.hasOwnProperty.call(SYMBOLS, icon);
  const Symbol = hasSymbol
    ? SYMBOLS[icon as WorkspaceSymbolId]
    : PanelsTopLeft;
  return (
    <span
      className={className}
      aria-hidden="true"
      data-workspace-icon={image ? 'image' : emoji || hasSymbol ? String(icon) : 'layout'}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, width: size, height: size, fontSize: size, lineHeight: 1 }}
    >
      {image ? (
        <img src={image.dataUrl} alt="" draggable={false}
          onError={() => setFailedImage(image.dataUrl)}
          style={{ width: size, height: size, objectFit: 'contain', borderRadius: Math.min(4, size / 8) }} />
      ) : emoji ?? <Symbol size={size} />}
    </span>
  );
}
