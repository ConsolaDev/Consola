import type { Me } from '../domain/me';

function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}

export function ProfileCard({ me }: { me: Me }) {
  const { user, organization, role } = me;
  return (
    <section className="card profile">
      {user.image ? (
        <img className="avatar" src={user.image} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
      )}
      <h1 className="heading">{user.name}</h1>
      <p className="muted">{user.email}</p>
      <p>
        {role === 'owner' ? 'Owner' : 'Member'} of {organization.name}
      </p>
    </section>
  );
}
