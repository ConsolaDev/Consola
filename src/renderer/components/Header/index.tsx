import { Flex, Text } from '@radix-ui/themes';
import * as Tabs from '@radix-ui/react-tabs';
import { useTerminalStore } from '../../stores/terminalStore';
import './styles.css';

export default function Header() {
  const { mode, switchMode } = useTerminalStore();

  return (
    <header className="header">
      <Tabs.Root value={mode} onValueChange={(v) => switchMode(v as 'SHELL' | 'CLAUDE')}>
        <Tabs.List className="tabs-list">
          <Tabs.Trigger value="SHELL" className="tab-trigger">
            <span className="indicator shell" />
            <Text size="2" weight="medium">Shell</Text>
          </Tabs.Trigger>
          <Tabs.Trigger value="CLAUDE" className="tab-trigger">
            <span className="indicator claude" />
            <Text size="2" weight="medium">Claude</Text>
          </Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>

      <Text size="1" className="app-title">Console-1</Text>
    </header>
  );
}
