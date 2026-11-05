import { useState } from 'react';
import { RotateCw, FilePlus, FileX, Lock, Unlock } from 'lucide-react';
import type { HarnessLaunchFields } from '../../../shared/types';
import { useTerminalStore } from '../../stores/terminalStore';
import { workspaceBridge } from '../../services/workspaceBridge';
import { useTerminal } from './useTerminal';
import { useTerminalFileDrop } from './useTerminalFileDrop';
import { activateSession, restartSession } from '../../utils/sessionActions';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

interface TerminalPanelProps {
    instanceId: string;
    workspaceId: string;
    /** The session record this tab shows, for actions that act on it. */
    sessionId: string;
    /**
     * Set for a read-only session (every one an automation starts): the
     * automation that started it, when one did. Its restriction is never
     * lifted in place — the person continues in a fork of their own.
     */
    readOnly?: { startedBy?: string };
    cwd: string;
    /** Session ID Consola assigned to this tab. */
    claudeSessionId: string;
    /** Whether this tab has run before and should resume its conversation. */
    resume: boolean;
    /** Binary, config directory and arguments from this session's harness. */
    harness: HarnessLaunchFields;
    /** Model this session was pinned to, replayed on every launch. */
    model?: string;
}

/**
 * The main panel: Claude Code's own terminal interface.
 *
 * Consola renders the surrounding chrome and lets the CLI own the conversation,
 * so every feature Claude ships is available here without being reimplemented.
 */
export function TerminalPanel({
    instanceId,
    workspaceId,
    sessionId,
    readOnly,
    cwd,
    claudeSessionId,
    resume,
    harness,
    model,
}: TerminalPanelProps) {
    const { containerRef, focus } = useTerminal({
        instanceId,
        workspaceId,
        cwd,
        claudeSessionId,
        resume,
        harness,
        model,
    });

    const { isDragging, notice, dropProps } = useTerminalFileDrop({
        instanceId,
        cwd,
        onDropped: focus,
    });

    const hasExited = useTerminalStore((state) => state.terminals[instanceId]?.hasExited ?? false);
    const isBusy = useTerminalStore((state) => state.terminals[instanceId]?.isBusy ?? false);
    const [forking, setForking] = useState(false);
    const [forkError, setForkError] = useState<string | null>(null);

    const handleRestart = () => {
        restartSession(instanceId);
        focus();
    };

    const handleFork = () => {
        setForking(true);
        setForkError(null);
        workspaceBridge
            .forkSession(workspaceId, sessionId)
            .then((fork) => activateSession(workspaceId, fork.id))
            .catch((error: unknown) => setForkError(error instanceof Error ? error.message : String(error)))
            .finally(() => setForking(false));
    };

    return (
        <div className="terminal-panel">
            {/*
              * Holds the restart action, so it appears with it — and, on a
              * read-only session, says so for as long as it is one. A bar that
              * is empty whenever the session is healthy would spend nearly all
              * of its life taking height from the terminal for nothing.
              */}
            {(hasExited || readOnly) && (
                <div className="terminal-panel-toolbar">
                    {readOnly && (
                        <span className="terminal-read-only-label">
                            <Lock size={12} />
                            <span>{readOnly.startedBy ? `Read-only · started by ${readOnly.startedBy}` : 'Read-only'}</span>
                        </span>
                    )}
                    {hasExited && (
                        <button
                            type="button"
                            className="terminal-restart-button"
                            onClick={handleRestart}
                            title={readOnly ? 'Continue this conversation, still read-only' : 'Claude exited — resume this conversation'}
                        >
                            <RotateCw size={13} />
                            <span>{readOnly ? 'Continue' : 'Restart'}</span>
                        </button>
                    )}
                    {readOnly && (
                        <button
                            type="button"
                            className="terminal-fork-button"
                            onClick={handleFork}
                            // Mid-turn, the conversation is not all written yet.
                            disabled={forking || (isBusy && !hasExited)}
                            title="Continue this conversation in a new session of your own, with your usual tools"
                        >
                            <Unlock size={13} />
                            <span>Continue with full tools</span>
                        </button>
                    )}
                    {forkError && <span className="terminal-toolbar-error">{forkError}</span>}
                </div>
            )}

            {/*
              * The drop zone is the frame rather than the xterm box: xterm sizes
              * itself from that box, and an overlay inside it would be measured
              * as content. Cancelling the dragover is what claims a file drag
              * here, and the window-level guard swallows everything it leaves.
              */}
            <div className="terminal-surface-frame" {...dropProps}>
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
