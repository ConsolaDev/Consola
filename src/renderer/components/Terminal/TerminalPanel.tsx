import { RotateCw, FilePlus, FileX } from 'lucide-react';
import type { HarnessLaunchFields } from '../../../shared/types';
import { useTerminalStore } from '../../stores/terminalStore';
import { useTerminal } from './useTerminal';
import { useTerminalFileDrop } from './useTerminalFileDrop';
import { restartSession } from '../../utils/sessionActions';
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

    const { isDragging, notice, dropProps } = useTerminalFileDrop({
        instanceId,
        cwd,
        onDropped: focus,
    });

    const hasExited = useTerminalStore((state) => state.terminals[instanceId]?.hasExited ?? false);

    const handleRestart = () => {
        restartSession(instanceId);
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

            {/*
              * The drop zone is the frame rather than the xterm box: xterm sizes
              * itself from that box, and an overlay inside it would be measured
              * as content. `data-file-drop-zone` is what tells the window-level
              * guard to leave this subtree's drops alone.
              */}
            <div className="terminal-surface-frame" data-file-drop-zone {...dropProps}>
                <div ref={containerRef} className="terminal-surface" onClick={focus} />

                {isDragging && (
                    <div className="terminal-drop-overlay">
                        <FilePlus size={20} />
                        <span>Drop files to add to the conversation</span>
                    </div>
                )}

                {/*
                  * A drag with nothing on disk behind it — an image dragged out
                  * of a browser — would otherwise look like the drop was lost.
                  */}
                {!isDragging && notice && (
                    <div className="terminal-drop-notice">
                        <FileX size={14} />
                        <span>{notice}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
