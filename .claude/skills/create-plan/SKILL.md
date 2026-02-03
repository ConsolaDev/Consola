---
name: create-plan
description: Create detailed implementation plans stored in your issue tracker
model: opus
---

# Create Implementation Plan

Create detailed implementation plans through an interactive, iterative process. Plans are stored as tickets in your configured issue tracker.

## Prerequisites

This skill requires:
1. A configured issue tracker (run `/init-tracker` if not set up)
2. The tracker's MCP tools to be available (run `/mcp` to verify)

## Configuration

Read project configuration from `.claude/config.json`:
- `tracker.type` - Which tracker to use (linear, jira)
- `tracker.team` - Team/project to create tickets in
- `tracker.statuses` - Status mappings for workflow
- `tracker.labels` - Available labels
- `project.commands` - Build/test commands for success criteria

## Initial Response

When invoked:

1. **Read the config file** at `.claude/config.json`
   - If missing, instruct user to run `/init-tracker` first

2. **If a ticket ID is provided** (e.g., `/create-plan ABC-123`):
   - Fetch the ticket details from the configured tracker
   - Read the ticket description and any linked documents
   - Begin the research process

3. **If no parameters provided**, respond with:
   ```
   I'll help you create a detailed implementation plan stored in [tracker name].

   Please provide:
   1. The feature/task description or an existing ticket ID
   2. Any relevant context, constraints, or specific requirements
   3. References to related code areas or existing implementations

   I'll analyze this information and work with you to create a comprehensive plan.
   ```

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Research the codebase** to understand:
   - Use the Explore agent to find relevant files and understand current implementation
   - Identify patterns, conventions, and integration points
   - Find similar implementations to model after

2. **Present informed understanding**:
   ```
   Based on my research of the codebase, I understand we need to [summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that need clarification:
   - [Specific technical question requiring input]
   - [Design preference that affects implementation]
   ```

### Step 2: Research & Design Options

After initial clarifications:

1. **Spawn parallel research tasks** using the Explore agent:
   - Research database schema and migrations
   - Find API patterns to follow
   - Investigate service layer conventions
   - Check test patterns and coverage

2. **Present design options**:
   ```
   Based on my research:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   Which approach aligns best with your vision?
   ```

### Step 3: Plan Structure Development

Once aligned on approach:

1. **Create initial plan outline**:
   ```
   Here's my proposed plan structure:

   ## Overview
   [1-2 sentence summary]

   ## Implementation Phases:
   1. [Phase name] - [what it accomplishes]
   2. [Phase name] - [what it accomplishes]
   3. [Phase name] - [what it accomplishes]

   Does this phasing make sense?
   ```

2. **Get feedback** before writing full details

### Step 4: Create Ticket with Plan

After structure approval, create the ticket using the configured tracker.

**Read commands from config** for success criteria:
- Use `project.commands.build` for build verification
- Use `project.commands.test` for test verification
- Use `project.commands.testSpecific` for specific test commands

**Use this description template:**

```markdown
## Overview

[Brief description of what we're implementing and why]

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## Desired End State

[Specification of the desired end state and how to verify it]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

---

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file`
**Changes**: [Summary of changes]

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `[build command from config]`
- [ ] Tests pass: `[test command from config]`

#### Manual Verification:
- [ ] Feature works as expected
- [ ] No regressions in related features

**Note**: After completing Phase 1, move ticket to "In Review" for verification.

---

## Phase 2: [Descriptive Name]

[Similar structure...]

---

## Testing Strategy

### Unit Tests:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify]
2. [Expected result]

## References

- Related code: [file:line references]
- Similar implementation: [file:line]
```

**Create ticket using tracker-specific tools:**

For Linear:
```
mcp__linear-server__create_issue with:
- title: [Clear, action-oriented title]
- description: [Full plan in markdown]
- team: [from config: tracker.team.name]
- state: [from config: tracker.statuses.backlog.name]
- labels: [from config: appropriate label]
- priority: [from config: tracker.defaultPriority]
```

For Jira (future):
```
mcp__jira__create_issue with similar mapping
```

### Step 5: Review and Iterate

1. **Present the ticket**:
   ```
   I've created/updated the implementation plan:
   [Ticket URL]

   Please review:
   - Are the phases properly scoped?
   - Are the success criteria specific enough?
   - Any technical details that need adjustment?
   ```

2. **Iterate based on feedback** using `/iterate-plan`

## Important Guidelines

1. **Be Skeptical**: Question vague requirements, identify issues early
2. **Be Interactive**: Get buy-in at each step, allow course corrections
3. **Be Thorough**: Research actual code patterns, include file:line references
4. **Be Practical**: Focus on incremental, testable changes
5. **No Open Questions**: Resolve all questions before finalizing the plan

## Tracker-Specific Operations

### Reading Config
Always read `.claude/config.json` first to get:
- Tracker type and credentials
- Team/project settings
- Status and label mappings
- Build/test commands

### Status Mapping
Use the config's status mappings:
- `tracker.statuses.backlog` - New tickets
- `tracker.statuses.inProgress` - Active work
- `tracker.statuses.inReview` - Ready for review
- `tracker.statuses.done` - Completed

### Label Mapping
Use the config's label mappings:
- `tracker.labels.feature` - New features
- `tracker.labels.improvement` - Enhancements
- `tracker.labels.bug` - Bug fixes
