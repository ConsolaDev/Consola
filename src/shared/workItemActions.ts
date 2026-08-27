import { generateId } from './ids';
import { INBOX_SECTIONS, sectionItemType, type InboxSection } from './inboxSections';

/**
 * Actions: the verbs a workspace offers on a work item.
 *
 * Records on the workspace rather than code, so "fix CI" or "run a security
 * pass" is a settings edit. Consola prepends the provider's fixed context
 * header; the body here is the editable part and may be a bare slash command.
 */
export interface WorkItemAction {
  id: string;
  /** "Review", "Fix CI" — also the name snapshot a launched session keeps. */
  name: string;
  /** Non-empty. */
  appliesTo: Array<'pr' | 'issue'>;
  /** Body only, non-empty; the header is the provider's. */
  prompt: string;
  /**
   * Where a session launched from this action lands, by group id. Absent —
   * the default, and every pre-existing action — leaves it under the scope
   * it runs in, exactly as before.
   *
   * An id rather than a name, so `validateActionsWrite` can refuse a target
   * that does not exist and a renamed group keeps its arrivals. Contrast the
   * name snapshot a launched *session* keeps in `workItemAction`: that one
   * exists to survive the action being renamed or deleted, which is the
   * opposite requirement.
   */
  groupId?: string;
}

const DEFAULT_ACTION_TEMPLATES: ReadonlyArray<Omit<WorkItemAction, 'id'>> = [
  {
    name: 'Review',
    appliesTo: ['pr'],
    prompt: 'Review the changes and summarise your findings before writing any review comments.',
  },
  {
    name: 'Address review',
    appliesTo: ['pr'],
    prompt:
      'Read every unresolved review thread with `gh pr view {{number}} --comments`. Address each one: change the code or reply explaining why not. Push, then summarise what you did per thread.',
  },
  {
    name: 'Fix CI',
    appliesTo: ['pr'],
    prompt: 'Find the failing checks with `gh pr checks {{number}}`, reproduce locally, fix, push.',
  },
  {
    name: 'Implement',
    appliesTo: ['issue'],
    prompt: 'Investigate it and propose a plan before changing anything.',
  },
  {
    name: 'Triage',
    appliesTo: ['issue'],
    prompt: 'Reproduce, label the severity, and comment your findings. Do not change code.',
  },
];

/** Which default each section highlights, by action NAME — ids are minted per workspace. */
const DEFAULT_SECTION_ACTION_NAMES: Partial<Record<InboxSection, string>> = {
  'needs-your-review': 'Review',
  'needs-team-review': 'Review',
  'needs-action': 'Address review',
  waiting: 'Fix CI',
  issues: 'Implement',
};

/** Fresh records with fresh ids — never shared by reference between callers. */
export function createDefaultActions(): WorkItemAction[] {
  return DEFAULT_ACTION_TEMPLATES.map((template) => ({
    id: generateId(),
    name: template.name,
    appliesTo: [...template.appliesTo],
    prompt: template.prompt,
  }));
}

/**
 * Section defaults paired to the ids `createDefaultActions` just minted.
 *
 * Paired by name because that is the only stable handle across calls; a
 * section whose named action is missing gets no default rather than a
 * dangling id.
 */
export function createDefaultSectionDefaults(
  actions: WorkItemAction[]
): Partial<Record<InboxSection, string>> {
  const defaults: Partial<Record<InboxSection, string>> = {};
  for (const [section, name] of Object.entries(DEFAULT_SECTION_ACTION_NAMES) as Array<
    [InboxSection, string]
  >) {
    const action = actions.find((candidate) => candidate.name === name);
    if (action) defaults[section] = action.id;
  }
  return defaults;
}

/**
 * The name backfilled onto a pre-v7 session's workItemAction, by item type.
 *
 * The role a session was launched under was never persisted, so the type is
 * the best the migration can do — and today's hardcoded prompt was exactly
 * this split.
 */
export function defaultActionNameForType(type: 'pr' | 'issue'): string {
  return type === 'pr' ? 'Review' : 'Implement';
}

export interface ActionsWrite {
  actions: WorkItemAction[];
  sectionDefaults: Partial<Record<InboxSection, string>>;
}

export type ActionsValidationResult = { ok: true } | { ok: false; message: string };

function isKnownSection(value: string): value is InboxSection {
  return INBOX_SECTIONS.some((section) => section.id === value);
}

/**
 * The action the Inbox pane highlights for an item.
 *
 * `preferredId` is the section default; it only wins when it still exists
 * and applies to the item's type, because a default can dangle after a
 * delete or point at an action whose appliesTo was edited underneath it.
 * Otherwise the first applicable action in the user's own order wins —
 * which is what "drag to reorder" is for.
 */
export function defaultActionFor(
  actions: WorkItemAction[],
  itemType: 'pr' | 'issue',
  preferredId?: string
): WorkItemAction | undefined {
  const applicable = actions.filter((action) => action.appliesTo.includes(itemType));
  const preferred = preferredId
    ? applicable.find((action) => action.id === preferredId)
    : undefined;
  return preferred ?? applicable[0];
}

/**
 * Pure validation for workspace:set-actions: unique ids, a name, non-empty
 * appliesTo and prompt per action, every default pointing at an existing
 * action of a matching type, and every `groupId` naming a group the
 * workspace actually has. Shape checks come first because this runs on an
 * IPC payload, where TypeScript's types are long gone. Side-effect-free so
 * it is unit-testable without a running WorkspaceService; the whole write is
 * rejected on the first failure and the message is shown inline.
 *
 * `knownGroupIds` is required rather than defaulted: an omitted set would
 * silently reject every routed action, and there is exactly one production
 * caller to pass it.
 */
export function validateActionsWrite(
  write: ActionsWrite,
  knownGroupIds: ReadonlySet<string>
): ActionsValidationResult {
  if (!Array.isArray(write.actions)) return { ok: false, message: 'Actions must be a list.' };
  if (typeof write.sectionDefaults !== 'object' || write.sectionDefaults === null) {
    return { ok: false, message: 'Section defaults must be an object.' };
  }

  const seen = new Set<string>();
  for (const action of write.actions) {
    if (typeof action?.id !== 'string' || action.id === '') {
      return { ok: false, message: 'Every action needs an id.' };
    }
    if (seen.has(action.id)) return { ok: false, message: `Duplicate action id: ${action.id}` };
    seen.add(action.id);
    if (typeof action.name !== 'string' || action.name.trim() === '') {
      return { ok: false, message: 'Every action needs a name.' };
    }
    if (!Array.isArray(action.appliesTo) || action.appliesTo.length === 0) {
      return { ok: false, message: `"${action.name}" must apply to pull requests, issues, or both.` };
    }
    if (action.appliesTo.some((type) => type !== 'pr' && type !== 'issue')) {
      return { ok: false, message: `"${action.name}" applies to an unknown item type.` };
    }
    if (typeof action.prompt !== 'string' || action.prompt.trim() === '') {
      return { ok: false, message: `"${action.name}" needs a prompt.` };
    }
    // Archived groups are deliberately still valid targets: a group is
    // archived, never deleted, and launchWorkItem restores one on arrival.
    if (action.groupId !== undefined && !knownGroupIds.has(action.groupId)) {
      return { ok: false, message: `"${action.name}" lands in a group that does not exist.` };
    }
  }

  for (const [section, actionId] of Object.entries(write.sectionDefaults)) {
    if (actionId === undefined) continue;
    if (!isKnownSection(section)) return { ok: false, message: `Unknown inbox section: ${section}` };
    const action = write.actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      return {
        ok: false,
        message: `The default for "${section}" points at an action that does not exist.`,
      };
    }
    const wanted = sectionItemType(section);
    if (!action.appliesTo.includes(wanted)) {
      return {
        ok: false,
        message: `"${action.name}" cannot be the default for "${section}": it does not apply to ${
          wanted === 'pr' ? 'pull requests' : 'issues'
        }.`,
      };
    }
  }
  return { ok: true };
}
