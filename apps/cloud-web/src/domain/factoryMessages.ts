import {
  FACTORY_NAME_MAX,
  type FactoriesState,
  type FactoryChange,
  type FactorySave,
  type FactorySourceKind,
  type NewFactoryProblem,
  type SourceOption,
} from './factories';
import type { BroughtIn } from './factoryDraft';
import type { FactoryPageId } from './factoryNav';
import { messageForTeamsState } from './teamMessages';
import { regionName } from './workspace';

/** What the Factories section says, for each rule and each answer. */

export const FACTORIES_INTRO =
  'A factory holds automations, agents and skills as files. Its team sees it and changes it.';

/** Who sees which factories, said under the intro to everyone, whatever their role. */
export const FACTORIES_ACCESS_NOTE =
  'Owners and admins see every factory. Everyone else sees their teams’ factories.';

/** Said under the sidebar's Factories heading when the person sees none. */
export const NO_FACTORIES = 'No factories yet';

/** Said where a factory would be made, to someone the cell lists in no team. */
export const NO_TEAMS_TO_OWN =
  'You’re not in a team yet, so you can’t make a factory. Ask an owner or admin to add you to one.';

export const TEAM_HINT = 'Its team’s members see it and change it.';

export const MOVE_HINT =
  'Its new team’s members will see it and change it. Owners and admins always see it.';

/** What Move asks before it gives a factory to another team, which changes who sees it. */
export function moveQuestion(factory: string, from: string, to: string): string {
  return `Give ${factory} to ${to}? People in ${from} who aren’t in ${to} won’t see it any more, unless they’re owners or admins.`;
}

/** Said when the only team a person could move a factory to is the one it has. */
export const NO_OTHER_TEAM = 'You’re in no other team to move it to.';

export const SOURCE_HINT = 'Where its files come from can’t change yet.';

/** The name of each source the page shows, the ones that come later included. */
const SOURCE_NAMES: Record<SourceOption['kind'], string> = {
  stored: 'Stored by Consola',
  github: 'GitHub repository',
};

/** What each source means, said under its name. */
const SOURCE_DESCRIPTIONS: Record<SourceOption['kind'], string> = {
  stored: 'Consola keeps its files, and every version of them.',
  github: 'Consola reads its files from a repository you choose.',
};

export function sourceName(kind: FactorySourceKind | SourceOption['kind']): string {
  return SOURCE_NAMES[kind];
}

export function sourceDescription(kind: FactorySourceKind | SourceOption['kind']): string {
  return SOURCE_DESCRIPTIONS[kind];
}

/**
 * A factory's team, named. The cell lists every team that owns a factory the person sees, so
 * one missing is a list read between a change and the next load.
 */
export function teamLabel(team: { name: string } | null): string {
  return team ? team.name : 'Another team';
}

const PROBLEMS: Record<NewFactoryProblem, string> = {
  name_missing: 'Give the factory a name.',
  name_too_long: `Keep the name to ${FACTORY_NAME_MAX} characters.`,
  name_invalid: 'Use a name without line breaks or tabs.',
  team_missing: 'Choose the team that owns it.',
};

export function messageForFactoryProblem(problem: NewFactoryProblem): string {
  return PROBLEMS[problem];
}

/** What a form says, by the field it is about: its name, its team, or the form as a whole. */
export type FactoryFormMessages = { name?: string; team?: string; form?: string };

/** The problems with a new factory, each under its field. */
export function messagesForFactoryProblems(
  problems: readonly NewFactoryProblem[],
): FactoryFormMessages {
  const name = problems.filter((problem) => problem !== 'team_missing');
  const messages: FactoryFormMessages = {};
  if (name.length > 0) messages.name = name.map(messageForFactoryProblem).join(' ');
  if (problems.includes('team_missing')) messages.team = messageForFactoryProblem('team_missing');
  return messages;
}

/** Why the factories could not be shown, for the workspace and its region. */
export function messageForFactoriesState(
  state: Exclude<FactoriesState, { kind: 'listed' }>,
  workspace: { name: string; region: string },
): string {
  return messageForTeamsState(state, workspace);
}

/** What a factory missing from the list says: it is gone, or now another team's. */
export const FACTORY_GONE = 'This factory was deleted, or moved to a team you’re not in.';

/**
 * What a change that did not go through says, under the field it is about, or nothing for one
 * that did.
 */
export function messagesForFactoryChange(
  change: FactoryChange,
  workspace: { name: string; region: string },
): FactoryFormMessages {
  switch (change.kind) {
    case 'changed':
      return {};
    case 'invalid':
      return {
        name: change.problems.map(messageForFactoryProblem).join(' ') || 'That name can’t be used.',
      };
    case 'name-taken':
      return { name: 'Another factory already has that name.' };
    case 'team-not-found':
      return {
        team: 'That team was deleted, or you’re not in it any more. The list is up to date now.',
      };
    case 'factory-not-found':
      return { form: FACTORY_GONE };
    case 'pending':
    case 'switched':
    case 'signed-out':
    case 'unavailable':
      return { form: messageForFactoriesState(change, workspace) };
  }
}

/** Each page of a factory, as the sidebar lists it and the page's title names it. */
export const FACTORY_PAGE_LABELS: Record<FactoryPageId, string> = {
  definition: 'Factory definition',
  settings: 'Settings',
};

/** The chevron that shows or hides a factory's sections (its pages) in the sidebar. */
export function foldLabel(factoryName: string, unfolded: boolean): string {
  return unfolded ? `Hide ${factoryName}’s sections` : `Show ${factoryName}’s sections`;
}

/** The sidebar's one line for factories it could not list, short beside the page's sentences. */
export function sidebarLineForFactoriesState(
  state: Exclude<FactoriesState, { kind: 'listed' }>,
  workspace: { region: string },
): string {
  switch (state.kind) {
    case 'pending':
      return 'Still being set up.';
    case 'unavailable':
      return `The ${regionName(workspace.region)} region isn’t answering.`;
    case 'switched':
      return 'Another workspace is open now. Reload.';
    case 'signed-out':
      return 'Signed out. Reload to sign in.';
  }
}

export const LOADING_FACTORIES = 'Loading…';

/** Said where a factory's definition has no files yet, and what fills it. */
export const NO_FILES = 'No files yet.';
export const NO_FILES_HINT =
  'A factory is set up from a repository or the setup helper. Once its files are here, you can read them and make a quick edit.';

/** What the sidebar's dot on a factory's definition means. */
export const UNSAVED_EDITS = 'Unsaved changes';

/** Said where a factory's definition would be, when the page's code could not be loaded. */
export const DEFINITION_NOT_LOADED =
  'The factory’s files couldn’t be loaded on this page. Reload it to try again.';

/** The banner over a factory's definition, until the person hides it for good. */
export const DEFINITION_BANNER_TITLE = 'Your factory is defined in code';
export const DEFINITION_BANNER_TEXT =
  'Its automations, agents and skills live as files. Read them here, and make a quick edit when you need one.';

/** Said in the file list when its filter matches no file. */
export function noFileMatches(filter: string): string {
  return `No file matches “${filter.trim()}”.`;
}

/** How many problems the files have, as the Problems panel heads them. */
export function problemsCount(count: number): string {
  if (count === 0) return 'No problems';
  return count === 1 ? '1 problem' : `${count} problems`;
}

/** Why Save is off while the files have problems. */
export function fixToSave(count: number): string {
  return count === 1 ? 'Fix the problem to save.' : `Fix the ${count} problems to save.`;
}

/** Said in place of the problems while the page's check cannot run, as a save still can. */
export const CHECK_UNAVAILABLE =
  'The files can’t be checked on this page right now. Saving still checks them.';

/** Said over the problems the cell found that the page's own check did not. */
export const CELL_FOUND_PROBLEMS = 'Saving found problems, so nothing was saved.';

/** What Discard asks before it drops the person's changes. */
export function discardQuestion(files: number): string {
  return files === 1
    ? 'Discard your changes to 1 file? This can’t be undone.'
    : `Discard your changes to ${files} files? This can’t be undone.`;
}

/** Said when someone saved a newer version while the person was editing. */
export function versionMovedLine(latestVersion: number): string {
  return `Version ${latestVersion} was saved while you were editing. Saving now would undo it, so bring it in first.`;
}

export function bringInLabel(latestVersion: number): string {
  return `Bring in version ${latestVersion}`;
}

/** What bringing a newer version in came to: the files to check before saving, if any. */
export function broughtInLine(
  version: number,
  { bothChanged, goneThere, removedChanged, followed }: Omit<BroughtIn, 'draft'>,
): string {
  const said = [`Brought in version ${version}.`];
  if (bothChanged.length > 0) {
    said.push(
      `You and they both changed ${listOf(bothChanged)}: yours is kept, so check it before saving.`,
    );
  }
  if (goneThere.length > 0) {
    said.push(`Version ${version} removed ${listOf(goneThere)}: saving adds your copy back.`);
  }
  if (removedChanged.length > 0) {
    const one = removedChanged.length === 1;
    said.push(
      `Version ${version} changed ${listOf(removedChanged)}, which you removed: ${one ? 'it stays' : 'they stay'} removed, and Restore brings back yours.`,
    );
  }
  if (followed.length > 0) {
    const one = followed.length === 1;
    said.push(
      one
        ? `Version ${version} changed ${listOf(followed)} under its old name: the change moved with your rename, so check it before saving.`
        : `Version ${version} changed ${listOf(followed)} under their old names: the changes moved with your renames, so check them before saving.`,
    );
  }
  if (said.length === 1) said.push('Your changes are on top of it.');
  return said.join(' ');
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function listOf(paths: readonly string[]): string {
  return LIST.format(paths);
}

/** What a save that did not land says; a refusal of the files themselves shows as problems. */
export function messageForSave(
  answer: Exclude<FactorySave, { kind: 'saved' } | { kind: 'invalid' } | { kind: 'version-moved' }>,
  workspace: { name: string; region: string },
): string {
  switch (answer.kind) {
    case 'too-large':
      return 'These files are more than a factory can hold, so nothing was saved.';
    case 'not-found':
      return FACTORY_GONE;
    default:
      return messageForFactoriesState(answer, workspace);
  }
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const ON_DATE = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/**
 * When something was saved, said: "just now", "5 minutes ago", "3 hours ago", "yesterday", "4
 * days ago", then its date. Null for a time that cannot be read.
 */
export function whenSaved(savedAt: string, now: Date): string | null {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return RELATIVE.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, 'hour');
  const startOf = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate());
  // Rounded, so a day that is 23 or 25 hours long (a clock change) still counts as one.
  const days = Math.round((startOf(now).getTime() - startOf(date).getTime()) / 86_400_000);
  if (days <= 6) return RELATIVE.format(-Math.max(days, 1), 'day');
  return ON_DATE.format(date);
}

/** A factory's version, as its definition heads it: "Version 3, saved 2 hours ago". */
export function versionLine(version: { version: number; savedAt: string }, now: Date): string {
  const when = whenSaved(version.savedAt, now);
  return when ? `Version ${version.version}, saved ${when}` : `Version ${version.version}`;
}

/**
 * When a version was saved, and by the person if it was them: "saved 2 hours ago", "saved just
 * now by you". Someone else is not named: the page holds no one's name but the person's.
 */
export function savedWords(
  version: { savedAt: string; savedBy: string },
  now: Date,
  personId: string,
): string | null {
  const when = whenSaved(version.savedAt, now);
  if (!when) return null;
  return version.savedBy === personId ? `saved ${when} by you` : `saved ${when}`;
}
