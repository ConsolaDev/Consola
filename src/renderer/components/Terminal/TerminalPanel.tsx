import { RotateCw } from 'lucide-react';
import type { HarnessLaunchFields } from '../../../shared/types';
import { useTerminalStore } from '../../stores/terminalStore';
import { terminalBridge } from '../../services/terminalBridge';
import { useTerminal } from './useTerminal';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

interface TerminalPanelProps {
    instanceId: string;
    cwd: string;
    /** Session ID Consola assigned to this tab. */
    claudeSessionId: string;
    /** Whether this tab has run before and should resume its conversation. */
    resume: boolean;
    /** Binary, config directory and arguments from this session's harness. */
    harness: HarnessLaunchFields;
}

/**
 * The main panel: Claude Code's own terminal interface.
 *
 * Consola renders the surrounding chrome and lets the CLI own the conversation,
 * so every feature Claude ships is available here without being reimplemented.
 */
export function TerminalPanel({
    instanceId,
    cwd,
    claudeSessionId,
    resume,
    harness,
}: TerminalPanelProps) {
    const { containerRef, focus } = useTerminal({
        instanceId,
        cwd,
        claudeSessionId,
        resume,
        harness,
    });

    const hasExited = useTerminalStore((state) => state.terminals[instanceId]?.hasExited ?? false);

    const handleRestart = () => {
        terminalBridge.restart(instanceId);
        useTerminalStore.getState().setState(instanceId, { hasExited: false });
        focus();
    };

    return (
        <div className="terminal-panel">
            {/*
              * Only ever holds the restart action, so it appears with it. A bar
              * that is empty whenever the session is healthy would spend nearly
              * all of its life taking height from the terminal for nothing.
              */}
            {hasExited && (
                <div className="terminal-panel-toolbar">
                    <button
                        type="button"
                        className="terminal-restart-button"
                        onClick={handleRestart}
                        title="Claude exited — resume this conversation"
                    >
                        <RotateCw size={13} />
                        <span>Restart</span>
                    </button>
                </div>
            )}

            <div className="terminal-surface-frame">
                <div ref={containerRef} className="terminal-surface" onClick={focus} />
            </div>
        </div>
    );
}
