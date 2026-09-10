import type { ReactNode } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { useShellStore } from '../../stores/shellStore';
import { ShellPanel } from './ShellPanel';

export function SessionTerminalLayout({ instanceId, children }: { instanceId: string; children: ReactNode }) {
  const open = useShellStore(state => state.open[instanceId] ?? false);
  return <div className="session-terminal-layout">
    <Group orientation="vertical">
      <Panel id="conversation" defaultSize="65%" minSize="20%">{children}</Panel>
      {open && <>
        <Separator className="shell-resize-handle" />
        <Panel id="shell" defaultSize="35%" minSize="20%">
          <ShellPanel key={instanceId} instanceId={instanceId} />
        </Panel>
      </>}
    </Group>
  </div>;
}
