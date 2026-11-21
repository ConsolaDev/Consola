export type Org = { name: string; slug: string };

export type Me = {
  user: { id: string; name: string; email: string; image: string | null };
  organization: { id: string; name: string; slug: string };
  role: string;
};

export type MeState =
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out' }
  | { kind: 'not-member' }
  | { kind: 'unavailable' };
