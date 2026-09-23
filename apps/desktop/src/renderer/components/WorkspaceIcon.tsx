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
  icon, name, size = 16, className, borderRadius,
}: { icon?: WorkspaceIconValue; name?: string; size?: number; className?: string; borderRadius?: number }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = isWorkspaceImageIcon(icon) && icon.dataUrl !== failedImage ? icon : undefined;
  const emoji = WORKSPACE_EMOJIS.find(([id]) => id === icon)?.[2];
  const hasSymbol = typeof icon === 'string' && Object.prototype.hasOwnProperty.call(SYMBOLS, icon);
  const Symbol = hasSymbol
    ? SYMBOLS[icon as WorkspaceSymbolId]
    : PanelsTopLeft;
  const initial = Array.from(name?.trim() || 'Workspace')[0].toLocaleUpperCase();
  const isInitial = !image && !emoji && !hasSymbol;
  const avatarSize = isInitial ? Math.max(20, size) : size;
  return (
    <span
      className={className}
      aria-hidden="true"
      data-workspace-icon={image ? 'image' : emoji || hasSymbol ? String(icon) : 'initial'}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, width: avatarSize, height: avatarSize,
        fontSize: isInitial ? avatarSize * 0.65 : size, lineHeight: 1,
        ...(isInitial ? {
          background: 'var(--color-bg-hover)',
          color: 'var(--color-text-primary)',
          borderRadius: borderRadius ?? Math.max(3, avatarSize / 5),
        } : {}),
      }}
    >
      {image ? (
        <img src={image.dataUrl} alt="" draggable={false}
          onError={() => setFailedImage(image.dataUrl)}
          style={{ width: size, height: size, objectFit: 'contain', borderRadius: borderRadius ?? Math.min(4, size / 8) }} />
      ) : emoji ?? (hasSymbol ? <Symbol size={size} /> : <span style={{ fontWeight: 600 }}>{initial}</span>)}
    </span>
  );
}
