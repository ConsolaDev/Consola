import {
  CalendarClock,
  CircleDot,
  Cloud,
  Coins,
  CornerLeftUp,
  Factory,
  FileCode,
  GitCommitVertical,
  GitPullRequest,
  Link2,
  MessageCircleQuestion,
  Radar,
  ShieldCheck,
  Tag,
  Timer,
  Webhook,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import {
  appliesToWords,
  fileVersionWords,
  modeWords,
  triggerDefinitionWords,
} from '../domain/runFile';
import { NO_CHILDREN_WORDS } from '../domain/runMessages';
import {
  isLive,
  type RunDetail,
  type RunSource,
  type RunSummary,
  safeItemUrl,
  type Starter,
  starterOf,
} from '../domain/runs';
import { hashOfRun } from '../domain/runsRoute';
import {
  agoInWords,
  costInWords,
  durationInWords,
  fullTime,
  itemLabel,
  lookOf,
  progressWords,
  questionWords,
  runnerWords,
  shareOf,
  statusWords,
  triggerWords,
  versionWords,
  workedFor,
} from '../domain/runWords';
import type { WorkspaceMember } from '../domain/teams';
import { Avatar } from './Avatar';
import { InfoPanel, InfoQuiet, InfoRow, InfoSection } from './InfoPanel';
import { StatusGlyph } from './RunStatusIcon';

const ICON = 14;

/** The info panel's sections, by id: what the page keeps folded. */
export type RunInfoSectionId = 'request' | 'automations' | 'budget' | 'run' | 'definition';

/**
 * A run's facts beside it, as the desktop's info panel states a session's. A request has three
 * sections: the request itself, the automations it started (each live, each opening in the
 * request's Automations tab) and its budget. An automation run has what it is, what started it (its request, when one
 * did, which it links to) and what it cost; then, when the cell holds the file it ran, its
 * Definition: the file (a link to its File view), the version against the latest, the trigger,
 * the mode and what it applies to.
 */
export function RunInfoPanel({
  detail,
  onShowChild,
  members,
  latestVersion,
  now,
  isOpen,
  onToggle,
}: {
  detail: RunDetail;
  /** Shows an automation the request started in its Automations tab, open and scrolled to. */
  onShowChild: (childId: string) => void;
  members: WorkspaceMember[] | null;
  latestVersion: number | null;
  now: number;
  isOpen: (id: RunInfoSectionId) => boolean;
  onToggle: (id: RunInfoSectionId) => void;
}) {
  const { run, request } = detail;
  const starter = starterOf(run, members);
  const fold = (id: RunInfoSectionId) => ({ open: isOpen(id), onToggle: () => onToggle(id) });

  if (request) {
    const ended = detail.children.filter((child) => !isLive(child)).length;
    return (
      <InfoPanel label="Request info">
        <InfoSection title="Request" {...fold('request')}>
          <StatusRow run={run} now={now} />
          <StarterRow run={run} starter={starter} parent={null} now={now} />
          <FactoryRow run={run} latestVersion={latestVersion} />
          <ItemRow run={run} />
          {request.question && (
            <InfoRow
              icon={<MessageCircleQuestion size={ICON} />}
              label={questionWords(request.question, now)}
              title={`Asked ${fullTime(request.question.at)}; open until ${fullTime(request.question.until)}`}
              tone="warning"
            />
          )}
          <InfoRow icon={<Cloud size={ICON} />} label={`Runs on ${runnerWords(run.runner)}`} />
        </InfoSection>

        <InfoSection
          title="Automations"
          {...fold('automations')}
          actions={
            detail.children.length > 0 ? (
              <span title={`${ended} of ${detail.children.length} ended`}>
                {ended}/{detail.children.length}
              </span>
            ) : undefined
          }
        >
          {detail.children.length === 0 ? (
            <InfoQuiet>{NO_CHILDREN_WORDS}</InfoQuiet>
          ) : (
            detail.children.map((child) => (
              <ChildRow
                key={child.id}
                requestId={run.id}
                run={child}
                now={now}
                onShow={() => onShowChild(child.id)}
              />
            ))
          )}
        </InfoSection>

        <InfoSection title="Budget" {...fold('budget')}>
          <BudgetRows budget={request.budget} spent={request.spent} />
        </InfoSection>
      </InfoPanel>
    );
  }

  return (
    <InfoPanel label="Run info">
      <InfoSection title="Run" {...fold('run')}>
        <StatusRow run={run} now={now} />
        {run.automation && (
          <InfoRow
            icon={<Workflow size={ICON} />}
            label={run.automation}
            value={run.progress ? stepCount(run.progress) : undefined}
            title={run.progress ? progressWords(run.progress) : undefined}
          />
        )}
        <FactoryRow run={run} latestVersion={latestVersion} />
        <StarterRow run={run} starter={starter} parent={detail.parent} now={now} />
        <ItemRow run={run} />
        <InfoRow icon={<Cloud size={ICON} />} label={`Runs on ${runnerWords(run.runner)}`} />
        {run.costUsd !== null && (
          <InfoRow icon={<Coins size={ICON} />} label="Cost" value={costInWords(run.costUsd)} />
        )}
      </InfoSection>
      {detail.source && (
        <InfoSection title="Definition" {...fold('definition')}>
          <DefinitionRows runId={run.id} source={detail.source} />
        </InfoSection>
      )}
    </InfoPanel>
  );
}

/** What the run executed, as its factory's file defines it. */
function DefinitionRows({ runId, source }: { runId: string; source: RunSource }) {
  return (
    <>
      <InfoRow
        icon={<FileCode size={ICON} />}
        label={<code className="run-info-code run-info-path">{source.path}</code>}
        title={`Show ${source.path} as the run executed it`}
        href={hashOfRun(runId, { view: 'file', step: null, run: null })}
      />
      <InfoRow
        icon={<GitCommitVertical size={ICON} />}
        label={fileVersionWords(source.version, source.latestVersion)}
        title="The version this run executed, and the factory’s latest"
      />
      <InfoRow
        icon={<Zap size={ICON} />}
        label={
          source.trigger.detail ? (
            <>
              {triggerDefinitionWords(source.trigger.kind)}{' '}
              <code className="run-info-code">{source.trigger.detail}</code>
            </>
          ) : (
            triggerDefinitionWords(source.trigger.kind)
          )
        }
        title="Trigger"
      />
      <InfoRow icon={<ShieldCheck size={ICON} />} label={modeWords(source.mode)} title="Mode" />
      <InfoRow
        icon={<Tag size={ICON} />}
        label={appliesToWords(source.appliesTo)}
        title="Applies to"
      />
    </>
  );
}

/** `2 of 4`, said short where `progressWords` says it whole. */
function stepCount(progress: NonNullable<RunSummary['progress']>): string {
  return `${progress.done} of ${progress.total}`;
}

/** A status glyph in its colour, in a row's icon column. */
function LookIcon({ run }: { run: Pick<RunSummary, 'status' | 'phase' | 'waitingOn'> }) {
  const look = lookOf(run);
  return (
    <span className="run-status run-status-small" data-look={look}>
      <StatusGlyph look={look} size={ICON} />
    </span>
  );
}

function StatusRow({ run, now }: { run: RunSummary; now: number }) {
  const worked = workedFor(run, now);
  return (
    <InfoRow
      icon={<LookIcon run={run} />}
      label={statusWords(run)}
      value={worked !== null ? durationInWords(worked) : undefined}
      title={run.finishedAt ? `Ended ${fullTime(run.finishedAt)}` : undefined}
      tone={run.error ? 'error' : undefined}
    />
  );
}

const TRIGGER_ICONS: Record<string, ReactNode> = {
  cron: <CalendarClock size={ICON} />,
  event: <Webhook size={ICON} />,
  poll: <Radar size={ICON} />,
};

/** Who or what started the run: a person, its request (a link to it), or a schedule, event or poll. */
function StarterRow({
  run,
  starter,
  parent,
  now,
}: {
  run: RunSummary;
  starter: Starter;
  parent: RunDetail['parent'];
  now: number;
}) {
  const when = agoInWords(run.createdAt, now);
  const at = `Started ${fullTime(run.createdAt)}`;
  if (parent) {
    return (
      <InfoRow
        icon={<CornerLeftUp size={ICON} />}
        label={parent.title}
        value={when}
        title={`Started by its request, “${parent.title}”`}
        href={hashOfRun(parent.id)}
      />
    );
  }
  if (starter.kind !== 'none') {
    const name =
      starter.kind === 'member'
        ? starter.member.name
        : starter.kind === 'left'
          ? 'Someone who left'
          : 'A person';
    const image = starter.kind === 'member' ? starter.member.image : null;
    return (
      <InfoRow
        icon={<Avatar user={{ name: starter.kind === 'member' ? name : '', image }} size={16} />}
        label={name}
        value={when}
        title={at}
        tone={starter.kind === 'member' ? undefined : 'muted'}
      />
    );
  }
  return (
    <InfoRow
      icon={TRIGGER_ICONS[run.trigger] ?? <Timer size={ICON} />}
      label={
        run.triggerDetail ? (
          <>
            {triggerWords(run.trigger)} <code className="run-info-code">{run.triggerDetail}</code>
          </>
        ) : (
          triggerWords(run.trigger)
        )
      }
      value={when}
      title={at}
    />
  );
}

function FactoryRow({ run, latestVersion }: { run: RunSummary; latestVersion: number | null }) {
  const older = latestVersion !== null && latestVersion > run.factory.version;
  return (
    <InfoRow
      icon={<Factory size={ICON} />}
      label={run.factory.name}
      value={
        older ? `v${run.factory.version} · latest v${latestVersion}` : `v${run.factory.version}`
      }
      title={`Factory ${run.factory.name}, ${versionWords(run.factory.version, latestVersion)}`}
    />
  );
}

/** The run's pull request or issue, a link to it on its own site. */
function ItemRow({ run }: { run: RunSummary }) {
  const { item } = run;
  if (!item) return null;
  const icon =
    item.kind === 'pr' ? (
      <GitPullRequest size={ICON} />
    ) : item.kind === 'issue' ? (
      <CircleDot size={ICON} />
    ) : (
      <Link2 size={ICON} />
    );
  const url = safeItemUrl(item.url);
  return (
    <InfoRow
      icon={icon}
      label={item.title}
      value={itemLabel(item) !== item.title ? itemLabel(item) : undefined}
      title={item.title}
      href={url ?? undefined}
      external
    />
  );
}

/**
 * One automation the request started, live: it opens in the request's Automations tab, scrolled
 * to; its own page is a modifier-click away, or "Open run" there.
 */
function ChildRow({
  requestId,
  run,
  now,
  onShow,
}: {
  requestId: string;
  run: RunSummary;
  now: number;
  onShow: () => void;
}) {
  const worked = workedFor(run, now);
  const time = worked !== null ? durationInWords(worked) : agoInWords(run.createdAt, now);
  const step = isLive(run) ? run.progress?.current : null;
  return (
    <InfoRow
      icon={<LookIcon run={run} />}
      label={run.automation ?? run.title}
      value={step ? `${step} · ${time}` : time}
      title={[
        statusWords(run),
        run.progress ? progressWords(run.progress) : null,
        run.error ?? run.summary,
      ]
        .filter(Boolean)
        .join('. ')}
      tone={run.error ? 'error' : undefined}
      href={hashOfRun(requestId, { view: 'automations', step: null, run: run.id })}
      onFollow={onShow}
    />
  );
}

/** What a request may spend and has spent, with a meter when it has a budget. */
function BudgetRows({
  budget,
  spent,
}: {
  budget: { usd: number; runs: number } | null;
  spent: { usd: number; runs: number };
}) {
  if (!budget) {
    return (
      <>
        <InfoRow icon={<Coins size={ICON} />} label="Spent" value={costInWords(spent.usd)} />
        <InfoRow
          icon={<Workflow size={ICON} />}
          label="Automations started"
          value={String(spent.runs)}
        />
        <InfoQuiet>No budget set: it may spend and start as much as it needs.</InfoQuiet>
      </>
    );
  }
  return (
    <>
      <BudgetRow
        icon={<Coins size={ICON} />}
        label="Spent"
        value={`${costInWords(spent.usd)} of ${costInWords(budget.usd)}`}
        share={shareOf(spent.usd, budget.usd)}
      />
      <BudgetRow
        icon={<Workflow size={ICON} />}
        label="Automations started"
        value={`${spent.runs} of ${budget.runs}`}
        share={shareOf(spent.runs, budget.runs)}
      />
    </>
  );
}

/** A row of the budget, with a meter under it that fills to what is spent, once, as it shows. */
function BudgetRow({
  icon,
  label,
  value,
  share,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  share: number;
}) {
  const level = share >= 1 ? 'over' : share >= 0.8 ? 'near' : 'within';
  return (
    <div className="run-budget">
      <InfoRow icon={icon} label={label} value={value} />
      <span className="run-meter" data-level={level} aria-hidden="true">
        <span className="run-meter-fill" style={{ transform: `scaleX(${share})` }} />
      </span>
    </div>
  );
}
