---
name: implement-plan
description: Implement technical plans from issue tracker tickets with verification
---

# Implement Plan

Implement an approved technical plan from an issue tracker ticket. Plans contain phases with specific changes and success criteria.

## Prerequisites

This skill requires:
1. A configured issue tracker (run `/init-tracker` if not set up)
2. The tracker's MCP tools to be available

## Getting Started

When given a ticket ID (e.g., `/implement-plan ABC-123`):

1. **Read config** from `.claude/config.json` to determine tracker type
2. **Fetch the ticket** using the appropriate tracker tool
3. **Read the plan completely** and check for any completed phases
4. **Read all files mentioned** in the plan - read them fully for complete context
5. **Create a todo list** to track your progress through the phases
6. **Update ticket status** to "In Progress" before starting

If no ticket ID provided, ask for one or list recent tickets from the configured tracker.

## Configuration

Read from `.claude/config.json`:
- `tracker.type` - Which tracker (linear, jira)
- `tracker.statuses` - For status transitions
- `project.commands` - For running verification commands

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update the ticket with progress comments as you complete sections

When things don't match the plan exactly, communicate clearly:
```
Issue in Phase [N]:
Expected: [what the plan says]
Found: [actual situation]
Why this matters: [explanation]

How should I proceed?
```

## Implementation Process

### For Each Phase:

1. **Mark phase as started** - Add a comment to the ticket:
   ```
   Starting Phase [N]: [Phase Name]
   ```

2. **Implement the changes**:
   - Follow the plan's specifications
   - Use existing patterns from the codebase
   - Write clean, consistent code following project guidelines

3. **Run automated verification** using commands from config:
   ```bash
   [project.commands.build]
   [project.commands.test]
   ```

4. **Fix any issues** before proceeding

5. **Update the ticket** with completion status:
   ```
   Phase [N] Complete

   Automated verification passed:
   - [x] Build passes
   - [x] Tests pass

   Changes made:
   - [Summary of changes with file references]
   ```

6. **Pause for manual verification** if the phase requires it:
   ```
   Phase [N] Complete - Ready for Manual Verification

   Automated verification passed:
   - [List automated checks that passed]

   Please perform the manual verification steps:
   - [List manual verification items from the plan]

   Let me know when manual testing is complete so I can proceed to Phase [N+1].
   ```

### After All Phases Complete:

1. **Update ticket status** to "In Review" (use config status mapping)

2. **Add final summary comment**:
   ```
   Implementation Complete

   All phases completed:
   - [x] Phase 1: [Name]
   - [x] Phase 2: [Name]

   Ready for final review and testing.
   ```

## Tracker-Specific Operations

### For Linear
```
# Fetch ticket
mcp__linear-server__get_issue with id: [ticket ID]

# Add comment
mcp__linear-server__create_comment with issueId, body

# Update status
mcp__linear-server__update_issue with id, state: [status name from config]
```

### For Jira (future)
```
# Similar operations with mcp__jira__* tools
```

## Verification Approach

After implementing a phase:
- Run the success criteria checks from the config commands
- Fix any issues before proceeding
- Check off completed items in your todo list

If instructed to execute multiple phases consecutively, skip the manual verification pause until the last phase.

## If You Get Stuck

When something isn't working as expected:
1. Make sure you've read and understood all relevant code
2. Consider if the codebase has evolved since the plan was written
3. Present the mismatch clearly and ask for guidance
4. Use the Explore agent for targeted debugging or exploring unfamiliar code

## Resuming Work

If the ticket has progress comments indicating completed phases:
- Trust that completed work is done
- Pick up from the first unchecked phase
- Verify previous work only if something seems off

## Status Workflow

Use status names from config (`tracker.statuses`):
- **backlog** → Plan created, not started
- **todo** → Approved, ready to implement
- **inProgress** → Active development
- **inReview** → Implementation complete, needs verification
- **done** → Verified and complete

## Best Practices

1. **Don't skip verification** - Run all automated checks
2. **Document as you go** - Add comments for non-obvious decisions
3. **Follow existing patterns** - Match the codebase conventions
4. **Keep phases atomic** - Each phase should be independently testable
5. **Communicate blockers** - Don't silently struggle

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind and maintain forward momentum.
