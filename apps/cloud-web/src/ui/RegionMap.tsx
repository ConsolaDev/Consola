import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { regionName } from '../domain/workspace';
import { DOT_REGIONS, WORLD_DOTS } from './worldDots';

/** The distance between dots' centres, and their radius, in the map's own units. */
const PITCH = 10;
const RADIUS = 2.4;
/** How long the region's dots take to light, nearest its middle first. */
const RIPPLE_MS = 720;

type Dot = { x: number; y: number };

const WIDTH = Math.max(...WORLD_DOTS.map((row) => row.length)) * PITCH;
const HEIGHT = WORLD_DOTS.length * PITCH;

/** Every land dot, and the dots of each region apart, read once from the mask. */
const { land, regions } = (() => {
  const land: Dot[] = [];
  const regions = new Map<string, Dot[]>();
  WORLD_DOTS.forEach((row, r) => {
    Array.from(row).forEach((cell, c) => {
      if (cell === '.') return;
      const dot = { x: c * PITCH + PITCH / 2, y: r * PITCH + PITCH / 2 };
      const region = DOT_REGIONS[cell];
      if (region === undefined) land.push(dot);
      else regions.set(region, [...(regions.get(region) ?? []), dot]);
    });
  });
  return { land, regions };
})();

/** Dots as one path, each a circle drawn as two arcs, so the map is a single element. */
function pathOf(dots: Dot[]): string {
  const r = RADIUS;
  return dots
    .map(({ x, y }) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`)
    .join('');
}

/** Each dot of a region with how long after the map appears it lights: from its middle out. */
function ripple(dots: Dot[]): { dot: Dot; delay: number }[] {
  const middle = {
    x: dots.reduce((sum, dot) => sum + dot.x, 0) / dots.length,
    y: dots.reduce((sum, dot) => sum + dot.y, 0) / dots.length,
  };
  const far = (dot: Dot) => Math.hypot(dot.x - middle.x, dot.y - middle.y);
  const farthest = Math.max(...dots.map(far), 1);
  return dots.map((dot) => ({ dot, delay: Math.round((far(dot) / farthest) * RIPPLE_MS) }));
}

/**
 * The world in dots with the workspace's region lit in the accent, which ripples on from the
 * region's middle once as the map appears (and is simply lit for someone who asked for reduced
 * motion). The other regions' land is drawn as plain land. A region the map has no dots for
 * lights nothing, and is named only by the words beside the map.
 */
export function RegionMap({ region }: { region: string }) {
  const { lit, land: landPath } = useMemo(() => {
    const others = [...regions].filter(([id]) => id !== region).flatMap(([, dots]) => dots);
    return { lit: ripple(regions.get(region) ?? []), land: pathOf([...land, ...others]) };
  }, [region]);

  return (
    <svg
      className="region-map"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={
        lit.length > 0
          ? `A map of the world with the ${regionName(region)} region marked`
          : 'A map of the world'
      }
    >
      <path className="region-map-land" d={landPath} />
      <g className="region-map-lit">
        {lit.map(({ dot, delay }) => (
          <circle
            key={`${dot.x} ${dot.y}`}
            cx={dot.x}
            cy={dot.y}
            r={RADIUS}
            style={{ animationDelay: `${delay}ms` } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
