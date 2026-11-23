import type { CSSProperties } from 'react';
import { initialsOf, type Me } from '../domain/me';

/**
 * A person's picture, round, or their initials where they have none. It says nothing to a
 * screen reader: the person's name is always written beside it.
 */
export function Avatar({ user, size }: { user: Me['user']; size: number }) {
  const style = { '--avatar-size': `${size}px` } as CSSProperties;
  return user.image ? (
    <img className="avatar" style={style} src={user.image} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar" style={style} aria-hidden="true">
      {initialsOf(user.name)}
    </span>
  );
}
