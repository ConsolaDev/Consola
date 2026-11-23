import { DropdownMenu } from '@radix-ui/themes';
import { ChevronsUpDown, LogOut } from 'lucide-react';
import { useState } from 'react';
import type { Me } from '../domain/me';
import { signOut } from '../services/authClient';
import { Avatar } from './Avatar';

/**
 * Who is signed in, at the foot of the dashboard's sidebar: their picture, name and email, and a
 * menu that signs them out. A failed sign-out says so above it; a successful one reloads the page.
 */
export function AccountMenu({ user }: { user: Me['user'] }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setFailure(null);
    const result = await signOut();
    if (result !== null) {
      setFailure(result);
      setPending(false);
    }
  }

  return (
    <>
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={pending}>
          <button type="button" className="account-trigger" aria-label={`Account: ${user.name}`}>
            <Avatar user={user} size={28} />
            <span className="account-text">
              <span className="account-name">{user.name}</span>
              <span className="account-email">{user.email}</span>
            </span>
            <ChevronsUpDown size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="top"
          align="start"
          variant="soft"
          color="gray"
          className="account-menu"
        >
          <DropdownMenu.Label>
            <span className="account-menu-email">{user.email}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Item disabled={pending} onSelect={() => void run()}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </>
  );
}
