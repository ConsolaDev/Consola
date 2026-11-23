import type { CSSProperties } from 'react';
import { factoryHue } from '../domain/factoryNav';
import { workspaceInitial } from '../domain/workspaceIcons';

/**
 * A factory's tile: its initial on a rounded square, drawn as a workspace's initial is
 * (`WorkspaceIcon`), in a colour its id picks (`factoryHue`), so it keeps it when renamed. It
 * says nothing to a screen reader: the factory's name is always written beside it.
 */
export function FactoryTile({
  factory,
  size,
}: {
  factory: { id: string; name: string };
  size: number;
}) {
  return (
    <span
      className="factory-tile"
      data-hue={factoryHue(factory.id)}
      style={{ '--factory-tile-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {workspaceInitial(factory.name)}
    </span>
  );
}
