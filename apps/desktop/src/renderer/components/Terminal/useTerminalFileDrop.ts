import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { terminalBridge } from '../../services/terminalBridge';

interface UseTerminalFileDropOptions {
    instanceId: string;
    /** The session's working directory; paths inside it become @-mentions. */
    cwd: string;
    /** Called after a drop so the user can keep typing where they dropped. */
    onDropped?: () => void;
}

/** A path is safe as a bare `@mention` only if it needs no quoting. */
const NEEDS_QUOTING = /[\s"'\\`$|&;<>()*?[\]{}#]/;

/** Long enough to read the notice, short enough not to sit on the terminal. */
const NOTICE_DURATION_MS = 4000;

/**
 * Turn dropped absolute paths into the text Claude should receive.
 *
 * Paths inside the session's working directory become `@relative` mentions —
 * Claude Code's own file-reference syntax, and what `addToChat` already inserts
 * for code selections. Anything outside it, or containing characters a shell
 * would interpret, falls back to a quoted absolute path.
 */
export function formatDroppedPaths(paths: string[], cwd: string): string {
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;

    const references = paths.map((path) => {
        if (path.startsWith(prefix)) {
            const relative = path.slice(prefix.length);
            if (relative && !NEEDS_QUOTING.test(relative)) {
                return `@${relative}`;
            }
        }
        return `"${path.replace(/(["\\])/g, '\\$1')}"`;
    });

    // Trailing space so the user can start typing straight after the drop.
    return `${references.join(' ')} `;
}

/**
 * Read the on-disk paths of dropped files.
 *
 * The web `File` type carries no path, so the answer comes from the preload
 * script's `webUtils.getPathForFile`. It is empty for drags that carry no file
 * on disk — an image dragged out of a browser, say — and those are skipped:
 * there is nothing for Claude to read.
 */
function readDroppedPaths(dataTransfer: DataTransfer): string[] {
    return Array.from(dataTransfer.files)
        .map((file) => terminalBridge.pathForFile(file))
        .filter((path) => path.length > 0);
}

function isFileDrag(dataTransfer: DataTransfer | null): boolean {
    return dataTransfer?.types.includes('Files') ?? false;
}

/**
 * Accept files dropped onto a session's terminal.
 *
 * Dropped paths are pasted into the running CLI rather than submitted, so a
 * drop reads as "add this to what I'm writing" — the same contract as the code
 * selection popup's `Add to chat`.
 */
export function useTerminalFileDrop({ instanceId, cwd, onDropped }: UseTerminalFileDropOptions) {
    const [isDragging, setIsDragging] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    // Dragging across xterm's nested layers fires leave/enter pairs that would
    // flicker the overlay, so track depth rather than a boolean.
    const depthRef = useRef(0);
    const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    }, []);

    /** Say why a drop did nothing, then get out of the way. */
    const showNotice = useCallback((message: string) => {
        if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
        setNotice(message);
        noticeTimerRef.current = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    }, []);

    const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
        if (!isFileDrag(event.dataTransfer)) return;
        event.preventDefault();
        depthRef.current += 1;
        setIsDragging(true);
    }, []);

    const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
        if (!isFileDrag(event.dataTransfer)) return;
        // Preventing the default is what makes this element a drop target.
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    }, []);

    const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
        if (!isFileDrag(event.dataTransfer)) return;
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) {
            setIsDragging(false);
        }
    }, []);

    const handleDrop = useCallback(
        (event: DragEvent<HTMLElement>) => {
            if (!isFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            depthRef.current = 0;
            setIsDragging(false);

            const paths = readDroppedPaths(event.dataTransfer);
            if (paths.length === 0) {
                showNotice('That drag carries no file on disk — copy it and paste instead.');
                return;
            }

            terminalBridge.paste(instanceId, formatDroppedPaths(paths, cwd));
            setNotice(null);
            onDropped?.();
        },
        [instanceId, cwd, onDropped, showNotice]
    );

    return {
        isDragging,
        notice,
        dropProps: {
            onDragEnter: handleDragEnter,
            onDragOver: handleDragOver,
            onDragLeave: handleDragLeave,
            onDrop: handleDrop,
        },
    };
}
