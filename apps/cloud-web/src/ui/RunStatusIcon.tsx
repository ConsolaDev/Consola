import {
  CalendarClock,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hand,
  MessageCircleQuestion,
  Radar,
  Webhook,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { progressOf } from '../domain/runs';
import type { RunSummary, Starter } from '../domain/runs';
import { childrenTone, childrenWords, lookOf, statusWords } from '../domain/runWords';
import type { RunLook } from '../domain/runWords';
import { Avatar } from './Avatar';

/** The pie's circumference: a circle of radius 3.5 drawn 7 wide fills a disc of radius 7. */
const PIE = 2 * Math.PI * 3.5;

/**
 * A status as a glyph, in the desktop's icon set and weight. What is still to happen is drawn in
 * outline: queued is a dashed ring, and a run at work is a ring that fills like a pie as its
 * steps (or a request's automations) end, so a glance says how far along it is without any
 * motion that loops. The ends are the desktop's: a check, a cross, a slash; a hand or a question
 * for a run that waits on someone.
 *
 * `ended` marks a run seen ending while the page was open: its check draws itself, once.
 */
export function StatusGlyph({
  look,
  progress = null,
  size = 16,
  ended = false,
}: {
  look: RunLook;
  progress?: number | null;
  size?: number;
  ended?: boolean;
}) {
  const props = { size, 'aria-hidden': true, className: 'run-glyph' } as const;
  switch (look) {
    case 'queued':
      return (
        <svg {...ring(size)} aria-hidden="true">
          <circle cx="12" cy="12" r="9" strokeDasharray="3.53 3.53" />
        </svg>
      );
    case 'running': {
      const filled = progress === null ? null : Math.max(0.12, progress) * PIE;
      return (
        <svg {...ring(size)} aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          {filled === null ? (
            <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
          ) : (
            <circle
              className="run-glyph-pie"
              cx="12"
              cy="12"
              r="3.5"
              strokeWidth="7"
              transform="rotate(-90 12 12)"
              style={{ strokeDasharray: `${filled} ${PIE}` }}
            />
          )}
        </svg>
      );
    }
    case 'needs-you':
      return <Hand {...props} />;
    case 'question':
      return <MessageCircleQuestion {...props} />;
    case 'completed':
      return <CircleCheck {...props} data-ended={ended || undefined} />;
    case 'failed':
      return <CircleX {...props} />;
    case 'stopped':
      return <CircleSlash {...props} />;
  }
}

/** An outline glyph's frame, as lucide draws its own: 24 wide, stroked 2. */
function ring(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    className: 'run-glyph',
  } as const;
}

/**
 * A run's status: its glyph in its colour, and, on a request, a badge counting the automations it
 * started, coloured by the one most worth a look. Its words are for a screen reader; whatever
 * shows one shows the run's title beside it.
 */
export function RunStatusIcon({
  run,
  size = 16,
  ended = false,
}: {
  run: Pick<RunSummary, 'kind' | 'status' | 'phase' | 'waitingOn' | 'progress' | 'children'>;
  size?: number;
  ended?: boolean;
}) {
  const look = lookOf(run);
  const children = run.children && run.children.total > 0 ? run.children : null;
  return (
    <span className="run-status" data-look={look}>
      <StatusGlyph look={look} progress={progressOf(run)} size={size} ended={ended} />
      {children && (
        <span className="run-status-badge" data-tone={childrenTone(children)} aria-hidden="true">
          {children.total > 99 ? '99+' : children.total}
        </span>
      )}
      <span className="sr-only">
        {statusWords(run)}
        {children && `, ${childrenWords(children)}`}.
      </span>
    </span>
  );
}

const TRIGGER_ICONS = { cron: CalendarClock, event: Webhook, poll: Radar } as const;

/**
 * Who started a run, as small as a list's row has room for: the person's picture, or a mark for
 * the schedule, event or poll that started it. Its words are the title a pointer brings up and a
 * screen reader's.
 */
export function StarterMark({
  starter,
  trigger,
  size = 18,
}: {
  starter: Starter;
  trigger: RunSummary['trigger'];
  size?: number;
}) {
  if (starter.kind === 'member') {
    return (
      <span className="run-starter" title={`Started by ${starter.member.name}`}>
        <Avatar user={starter.member} size={size} />
        <span className="sr-only">Started by {starter.member.name}</span>
      </span>
    );
  }
  if (starter.kind === 'left' || starter.kind === 'unknown') {
    const who = starter.kind === 'left' ? 'someone who left' : 'a person';
    return (
      <span className="run-starter" title={`Started by ${who}`}>
        <Avatar user={{ name: '', image: null }} size={size} />
        <span className="sr-only">Started by {who}</span>
      </span>
    );
  }
  // A person's run with no person named, or a way of starting this build does not know: no mark.
  if (!Object.hasOwn(TRIGGER_ICONS, trigger)) return null;
  const mark = trigger as keyof typeof TRIGGER_ICONS;
  const Icon = TRIGGER_ICONS[mark];
  const words = { cron: 'a schedule', event: 'an event', poll: 'a poll' }[mark];
  return (
    <span
      className="run-starter run-starter-trigger"
      title={`Started by ${words}`}
      style={{ '--starter-size': `${size}px` } as CSSProperties}
    >
      <Icon size={Math.round(size * 0.62)} aria-hidden="true" />
      <span className="sr-only">Started by {words}</span>
    </span>
  );
}
