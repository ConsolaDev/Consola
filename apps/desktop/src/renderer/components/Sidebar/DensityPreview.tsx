import type { CSSProperties } from 'react';
import { FolderGit2 } from 'lucide-react';
import type { HarnessDriverId } from '../../../shared/types';
import type { SidebarDensity } from '../../stores/settingsStore';
import { HarnessIcon } from '../HarnessIcon';

/** What each density is called and what it says, wherever it is offered. */
export const DENSITY_COPY: Record<SidebarDensity, { label: string; hint: string }> = {
  detailed: {
    label: 'Detailed',
    hint: 'Two lines: model and state over the name, worktree and labels under it',
  },
  compact: {
    label: 'Compact',
    hint: 'One line: harness, name and state. The rest is in the tooltip',
  },
};

/**
 * The shape of a density, in the navigation menu: bars where the words go,
 * at the same proportions as the real rows. Detailed draws two rows in the
 * height Compact draws four, which is the whole trade said without a word.
 *
 * Each row is indexed (`--row`) so the newly chosen sketch can settle in a
 * row at a time, the way the list behind the menu just did.
 */
export function DensitySketch({ density }: { density: SidebarDensity }) {
  if (density === 'detailed') {
    return (
      <span className="density-sketch density-sketch--detailed" aria-hidden="true">
        {[
          { key: 'first', title: '78%', meta: '34%', worktree: '52%', live: true },
          { key: 'second', title: '58%', meta: '26%' },
        ].map((row, index) => (
          <span
            key={row.key}
            className={`density-sketch-row ${index === 0 ? 'density-sketch-row--active' : ''}`}
            style={{ '--row': index } as CSSProperties}
          >
            <span className="density-sketch-line">
              <span className="density-sketch-mark" />
              <span className="density-sketch-bar" style={{ width: row.meta }} />
              <span
                className={`density-sketch-end ${row.live ? 'density-sketch-end--live' : ''}`}
              />
            </span>
            <span
              className="density-sketch-bar density-sketch-bar--title"
              style={{ width: row.title }}
            />
            {row.worktree && (
              <span
                className="density-sketch-bar density-sketch-bar--worktree"
                style={{ width: row.worktree }}
              />
            )}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="density-sketch density-sketch--compact" aria-hidden="true">
      {['72%', '54%', '64%', '46%', '60%'].map((width, index) => (
        <span
          key={width}
          className={`density-sketch-row ${index === 0 ? 'density-sketch-row--active' : ''}`}
          style={{ '--row': index } as CSSProperties}
        >
          <span className="density-sketch-line">
            <span className="density-sketch-mark" />
            <span className="density-sketch-bar density-sketch-bar--title" style={{ width }} />
            <span
              className={`density-sketch-end ${index === 0 ? 'density-sketch-end--live' : ''}`}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

interface SampleRow {
  driver: HarnessDriverId;
  name: string;
  model: string;
  /** A live state at the trailing edge, or else the age shown there. */
  state?: 'working' | 'needs-attention';
  age: string;
  worktree?: string;
}

const SAMPLE_ROWS: SampleRow[] = [
  {
    driver: 'claude',
    name: 'Fix the login redirect',
    model: 'Opus 4.6',
    state: 'working',
    age: '',
    worktree: 'fix/login-redirect',
  },
  { driver: 'codex', name: 'Tidy the README', model: 'GPT-5', age: '12m' },
  {
    driver: 'claude',
    name: 'Review the billing export',
    model: 'Sonnet 4.6',
    state: 'needs-attention',
    age: '',
  },
  { driver: 'claude', name: 'Map the cache layer', model: 'Opus 4.6', age: '2h' },
];

/** The trailing edge of a sample row, in the list's own status vocabulary. */
function SampleState({ row }: { row: SampleRow }) {
  if (!row.state) return <span className="density-sample-age">{row.age}</span>;
  return (
    <span className={`session-row-status session-row-status--${row.state}`}>
      <span className="session-row-status-mark" aria-hidden="true" />
      <span className="session-row-status-word">
        {row.state === 'working' ? 'Working' : 'Waiting'}
      </span>
    </span>
  );
}

/**
 * The same sessions as each density draws them, for Settings: real words at
 * the real proportions, so choosing is comparing two lists rather than
 * imagining one. Detailed fits two of them where Compact fits all four.
 */
export function DensitySample({ density }: { density: SidebarDensity }) {
  if (density === 'detailed') {
    return (
      <span className="density-sample density-sample--detailed" aria-hidden="true">
        {SAMPLE_ROWS.slice(0, 2).map((row, index) => (
          <span
            key={row.name}
            className={`density-sample-row ${index === 0 ? 'density-sample-row--active' : ''}`}
          >
            <span className="density-sample-meta">
              <HarnessIcon driverId={row.driver} decorative className="density-sample-harness" />
              <span className="density-sample-model">{row.model}</span>
              <span className="density-sample-spacer" />
              <SampleState row={row} />
            </span>
            <span className="density-sample-name">{row.name}</span>
            {row.worktree && (
              <span className="density-sample-worktree">
                <FolderGit2 size={10} aria-hidden="true" />
                {row.worktree}
              </span>
            )}
          </span>
        ))}
      </span>
    );
  }
  return (
    <span className="density-sample density-sample--compact" aria-hidden="true">
      {SAMPLE_ROWS.map((row, index) => (
        <span
          key={row.name}
          className={`density-sample-row ${index === 0 ? 'density-sample-row--active' : ''}`}
        >
          <HarnessIcon driverId={row.driver} decorative className="density-sample-harness" />
          <span className="density-sample-name">{row.name}</span>
          <SampleState row={row} />
        </span>
      ))}
    </span>
  );
}
