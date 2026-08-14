import { Terminal as TerminalIcon, SquareTerminal, RotateCw } from 'lucide-react';
import { TerminalMode, type HarnessLaunchFields } from '../../../shared/types';
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

    const mode = useTerminalStore((state) => state.terminals[instanceId]?.mode ?? TerminalMode.CLAUDE);
    const hasExited = useTerminalStore((state) => state.terminals[instanceId]?.hasExited ?? false);

    const handleToggleMode = () => {
        const nextMode = mode === TerminalMode.CLAUDE ? TerminalMode.SHELL : TerminalMode.CLAUDE;
        terminalBridge.switchMode(instanceId, nextMode);
        focus();
    };

    const handleRestart = () => {
        terminalBridge.restart(instanceId);
        useTerminalStore.getState().setState(instanceId, { hasExited: false });
        focus();
    };

    return (
        <div className="terminal-panel">
            <div className="terminal-panel-toolbar">
                <button
                    type="button"
                    className="terminal-mode-toggle"
                    onClick={handleToggleMode}
                    title={
                        mode === TerminalMode.CLAUDE
                            ? 'Switch to shell'
                            : 'Switch back to Claude'
                    }
                >
                    {mode === TerminalMode.CLAUDE ? (
                        <>
                            <TerminalIcon size={13} />
                            <span>Claude</span>
                        </>
                    ) : (
                        <>
                            <SquareTerminal size={13} />
                            <span>Shell</span>
                        </>
                    )}
                </button>

                {hasExited && (
                    <button
                        type="button"
                        className="terminal-restart-button"
                        onClick={handleRestart}
                        title="Claude exited — resume this conversation"
                    >
                        <RotateCw size={13} />
                        <span>Restart</span>
                    </button>
                )}
            </div>

            <div className="terminal-surface-frame">
                <div ref={containerRef} className="terminal-surface" onClick={focus} />
            </div>
        </div>
    );
}
