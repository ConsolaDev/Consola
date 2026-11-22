import type {
  AutomationMode,
  AutomationView,
  CheckView,
  EntryAgentsView,
} from '../../../shared/automations';
import { serverGrantLine } from './agentGrantWords';
import { formatAgo } from './presentation';

const items = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;

/** How the last check went, under an automation's lead; null before the first one. */
export function checkStatusLine(check: CheckView, now: Date): string | null {
  if (check.error) return `Last check failed: ${check.error}`;
  if (!check.lastAt) return null;
  const found = items(check.items ?? 0);
  if (check.baseline) {
    const changed = check.changed ? `, and when \`${check.changed}\` changes` : '';
    return `Watching ${found}. It runs for new ones${changed}.`;
  }
  return `Checked ${formatAgo(check.lastAt, now)}: ${found}, ${check.fired ?? 0} new`;
}

/**
 * A poll's next-check cell when no next check is given: it waits for Allow,
 * or a check is running now (the engine gives no `nextAt` while one runs).
 * One that has checked before is checking, not "not checked yet".
 */
export function noNextCheckWords(check: CheckView | undefined, needsAllow: boolean): string {
  if (needsAllow) return 'Not checking yet';
  return check?.lastAt ? 'Checking…' : 'Not checked yet';
}

/**
 * What a poll with no recent runs will do: check, and run for what is new or
 * changed; in `confirm`, ask to run. Not before it is allowed.
 */
export function pollRunsEmptyWords(
  view: Pick<AutomationView, 'mode' | 'check' | 'needsAllow'>,
): string {
  if (view.needsAllow) return 'It is not checking yet: allow it above.';
  const does = view.mode === 'confirm' ? 'asks to run' : 'runs';
  return `It checks every ${view.check?.every ?? 'so often'}, and ${does} for what is new or changed. Check now looks right away.`;
}

/** The items a check left out because their repository is not here; null when none. */
export function skippedWords(skipped: number): string | null {
  return skipped > 0 ? `${skipped} skipped: their repositories are not in this workspace` : null;
}

/** The banner above the Allow card. */
export function allowBannerWords(check: CheckView): string {
  return `Not checking yet. Allowing it lets Consola run this command every ${check.every}, as you.`;
}

/** What allowing grants, by mode. */
export function grantWords(mode: AutomationMode): string {
  if (mode === 'confirm') return 'It then checks; each run still waits for your approval.';
  if (mode === 'notify')
    return 'It then checks, and runs dry runs: agents review, commands only report.';
  return 'It then checks, and runs on its own when something is new or changed.';
}

/** "30 minutes" and "every 30m" both read "30m". */
function shortEvery(text: string): string | null {
  const match = /(\d+)\s*([a-z])/i.exec(text);
  return match ? `${match[1]}${match[2].toLowerCase()}` : null;
}

/**
 * A pipeline's trigger node for an entry that is not an Inbox event or a
 * schedule; null for those, which keep their own node. A template's preview
 * has no check, so its interval is read from its trigger text.
 */
export function triggerNodeWords(
  view: Pick<AutomationView, 'source'> & { check?: CheckView; trigger?: string },
): { kicker: string; title: string } | null {
  if (view.source === 'manual') return { kicker: 'On demand', title: 'On demand' };
  if (view.source !== 'poll') return null;
  const every = shortEvery(view.check?.every ?? view.trigger ?? '');
  return {
    kicker: 'Command check',
    title: every ? `Every ${every} · command` : 'On an interval · command',
  };
}

/** The Allow card's notes, from the view: an entry has no run definition to ask. */
export function allowNotes(view: Pick<AutomationView, 'steps' | 'takesItem'>): string[] {
  if (!view.steps?.some((step) => step.kind === 'run')) return [];
  return [
    'Its commands run as you (your logins, the bound GitHub account).',
    ...(view.takesItem === 'pr' || view.takesItem === 'pr-or-issue'
      ? [
          "In a pull request's worktree, a command that builds or tests runs the author's code with your logins.",
        ]
      : []),
  ];
}

/**
 * The Allow card's agent files: one `Uses agents/<name>.md` per agent the
 * entry's steps name, once each, in step order, so the person can open and
 * read every agent file the entry runs before allowing it.
 */
export function allowAgentLines(
  view: Pick<AutomationView, 'steps'>,
): Array<{ file: string; text: string }> {
  const files: string[] = [];
  for (const step of view.steps ?? []) {
    if (step.agentFile !== undefined && !files.includes(step.agentFile)) files.push(step.agentFile);
  }
  return files.map((file) => ({ file, text: `Uses ${file}` }));
}

/** Said above what a card shows while the folder does not apply: the text is the running version's. */
export const RUNNING_VERSION_NOTE = 'This is the version that runs; your edits have not applied.';

/**
 * A factory file's Open, beside a version the card shows: while the folder
 * does not apply, Open shows the file as it is now, which is not the version
 * shown (and not what Allow accepts), so it says so.
 */
export function openFileWords(standing: boolean): string {
  return standing ? 'Open as it is now' : 'Open in editor';
}

/** One agent on the Allow card: its file, and, once read at the listed version, its description and body. */
export interface AllowAgentSection {
  file: string;
  text: string;
  openLabel: string;
  description?: string;
  body?: string;
  /** While the folder does not apply: the body is the running version's. */
  note?: string;
  /** A line per server it names, with the tools its harness's last probe listed (2-C); absent for none. */
  servers?: string[];
  /** The skills it names, each opened by its `skills/<name>/SKILL.md`; absent for none. */
  skills?: string[];
}

/**
 * The Allow card's agents: each file the steps name, once, in step order,
 * with the description, body, servers and skills main read for the version
 * the view lists (`loaded`), never the live file, and whether its runs read
 * text other people wrote (`readsItems`, the item line). Allow accepts that
 * version, so it is `ready` only once every agent's body at that version is
 * there: the person reads exactly what they accept (review S1). An entry
 * without agents is ready at once.
 */
export function allowAgentSections(
  view: Pick<AutomationView, 'steps' | 'version'>,
  loaded: EntryAgentsView | null | undefined,
  standing: boolean,
): { ready: boolean; readsItems: boolean; agents: AllowAgentSection[] } {
  const atVersion = loaded && loaded.version === view.version ? loaded : undefined;
  const agents = allowAgentLines(view).map(({ file, text }): AllowAgentSection => {
    const agent = atVersion?.agents.find((candidate) => candidate.file === file);
    return {
      file,
      text,
      openLabel: standing ? openFileWords(true) : 'Open',
      ...(agent?.description !== undefined ? { description: agent.description } : {}),
      ...(agent ? { body: agent.body } : {}),
      ...(agent && standing ? { note: RUNNING_VERSION_NOTE } : {}),
      ...(agent && agent.mcpServers.length > 0
        ? { servers: agent.mcpServers.map((server) => serverGrantLine(server)) }
        : {}),
      ...(agent && agent.skills.length > 0 ? { skills: [...agent.skills] } : {}),
    };
  });
  return {
    ready: agents.every((agent) => agent.body !== undefined),
    readsItems: atVersion?.readsItems === true,
    agents,
  };
}
