import { HardDrive } from 'lucide-react';
import { useId } from 'react';
import { SOURCE_OPTIONS } from '../domain/factories';
import type { FactorySourceKind } from '../domain/factories';
import { SOURCE_HINT, sourceDescription, sourceName } from '../domain/factoryMessages';
import { ServiceMark } from './serviceMarks';
import './SourceChoice.css';

/**
 * Where a factory's files come from, as a choice of every source the page knows: the one the
 * API has (stored by Consola) and the ones that come later (a GitHub repository), shown so the
 * idea is there, and never chosen. On a new factory the stored source is chosen; on a factory's
 * settings nothing can be chosen (`readOnly`), since the source cannot change yet.
 */
export function SourceChoice({
  chosen,
  readOnly = false,
}: {
  chosen: FactorySourceKind;
  readOnly?: boolean;
}) {
  const id = useId();
  return (
    <fieldset
      className="field factories-sources"
      aria-describedby={readOnly ? `${id}-hint` : undefined}
    >
      <legend className="label">Files</legend>
      <div className="factories-source-options">
        {SOURCE_OPTIONS.map((option) => (
          <label
            key={option.kind}
            className="factories-source"
            data-unavailable={option.available ? undefined : ''}
          >
            <input
              type="radio"
              name={`${id}-source`}
              value={option.kind}
              checked={option.kind === chosen}
              disabled={readOnly || !option.available}
              readOnly
            />
            <span className="factories-source-mark" aria-hidden="true">
              {option.kind === 'github' ? (
                <ServiceMark service="github" size={16} />
              ) : (
                <HardDrive size={16} />
              )}
            </span>
            <span className="factories-source-text">
              <span className="factories-source-name">
                {sourceName(option.kind)}
                {!option.available && <span className="factories-later">Coming later</span>}
              </span>
              <span className="factories-source-description">{sourceDescription(option.kind)}</span>
            </span>
          </label>
        ))}
      </div>
      {readOnly && (
        <p id={`${id}-hint`} className="hint">
          {SOURCE_HINT}
        </p>
      )}
    </fieldset>
  );
}
