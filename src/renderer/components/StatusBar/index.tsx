import { Flex, Text } from '@radix-ui/themes';
import * as Tabs from '@radix-ui/react-tabs';
import { useTerminalStore } from '../../stores/terminalStore';
import type { TerminalMode } from '../../types/terminal';
import './styles.css';

export default function StatusBar() {
  const { mode, switchMode, isConnected, dimensions } = useTerminalStore();

  return (
    <footer className="status-bar">
      <Flex gap="4" align="center">
        <span className={`status-indicator ${isConnected ? 'connected' : ''}`} />

        <Tabs.Root value={mode} onValueChange={(v) => switchMode(v as TerminalMode)}>
          <Tabs.List className="tabs-list">
            <Tabs.Trigger value="SHELL" className="tab-trigger">
              <span className="indicator shell" />
              <Text size="1" weight="medium">Shell</Text>
            </Tabs.Trigger>
            <Tabs.Trigger value="CLAUDE" className="tab-trigger">
              <span className="indicator claude" />
              <Text size="1" weight="medium">Claude</Text>
            </Tabs.Trigger>
            <Tabs.Trigger value="AGENT" className="tab-trigger">
              <span className="indicator agent" />
              <Text size="1" weight="medium">Agent</Text>
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </Flex>

      <Text size="1" className="dimensions">
        {dimensions.cols} x {dimensions.rows}
      </Text>
    </footer>
  );
}
