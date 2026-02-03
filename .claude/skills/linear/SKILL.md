---
name: linear
description: Direct Linear operations - create, update, search tickets
---

# Linear Ticket Management

Direct operations for Linear issue tracking. Use this for quick ticket operations that don't require full planning workflows.

For planning workflows, use the generic skills:
- `/create-plan` - Create implementation plans
- `/implement-plan` - Implement planned tickets
- `/iterate-plan` - Update existing plans
- `/validate-plan` - Verify implementations

## Prerequisites

1. Linear MCP tools must be available (run `/mcp` to verify)
2. Project should be configured (run `/init-tracker` to set up)

## Configuration

Read team and label settings from `.claude/config.json`:
- `tracker.team` - Default team for operations
- `tracker.statuses` - Status ID mappings
- `tracker.labels` - Label ID mappings

## Quick Actions

### Create a Ticket
```
/linear create [title]
```

### Search Tickets
```
/linear search [query]
/linear my tickets
/linear in progress
```

### Update a Ticket
```
/linear update HAN-123 status done
/linear update HAN-123 assign me
```

### Add Comment
```
/linear comment HAN-123 [message]
```

## Available Operations

### 1. Create Ticket

```
mcp__linear-server__create_issue with:
- title: [title]
- description: [markdown content]
- team: [from config or ask]
- state: [from config statuses]
- labels: [from config labels]
- priority: [from config default or ask]
```

### 2. Search/List Tickets

```
mcp__linear-server__list_issues with:
- team: [from config]
- query: [search text]
- state: [filter by status]
- assignee: "me" for current user
- limit: 20
```

### 3. Get Ticket Details

```
mcp__linear-server__get_issue with:
- id: [ticket ID]
- includeRelations: true
```

### 4. Update Ticket

```
mcp__linear-server__update_issue with:
- id: [ticket ID]
- state: [status name]
- assignee: [user or "me"]
- priority: [1-4]
- labels: [label names]
```

### 5. Add Comment

```
mcp__linear-server__create_comment with:
- issueId: [ticket ID]
- body: [markdown content]
```

## Ticket Templates

### Feature Ticket
```markdown
## Problem to Solve

[What user problem or need does this address?]

## Proposed Solution

[High-level approach]

## Success Criteria

- [ ] [Measurable outcome 1]
- [ ] [Measurable outcome 2]

## Technical Notes

- Relevant files: `path/to/code`
- Similar implementation: [reference]
```

### Bug Ticket
```markdown
## Bug Description

[What is happening vs what should happen]

## Steps to Reproduce

1. [Step 1]
2. [Step 2]
3. [Observe bug]

## Expected Behavior

[What should happen instead]

## Technical Context

- Error location: `path/to/file:line`
- Related logs: [if applicable]
```

### Improvement Ticket
```markdown
## Current State

[How it works now]

## Proposed Improvement

[What should change and why]

## Impact

- Performance: [if applicable]
- User experience: [if applicable]
- Code quality: [if applicable]

## Implementation Notes

[Technical approach]
```

## Quick Reference Commands

**List my tickets:**
```
mcp__linear-server__list_issues with assignee: "me"
```

**List tickets in progress:**
```
mcp__linear-server__list_issues with state: "In Progress"
```

**List recent updates:**
```
mcp__linear-server__list_issues with updatedAt: "-P1D"
```

## Best Practices

1. **Clear titles**: Use action-oriented language ("Add user authentication" not "Authentication")
2. **Problem first**: Always describe the problem before the solution
3. **Keep updated**: Add comments as work progresses
4. **Link references**: Include code file references and related tickets
5. **Right labels**: Use Feature/Improvement/Bug appropriately
6. **Appropriate priority**: Default to Medium unless truly urgent

## Integration with Planning Skills

This skill is for quick, direct Linear operations. For structured work:

1. **New features**: Use `/create-plan` to create a proper implementation plan
2. **Implementing**: Use `/implement-plan HAN-123` to follow a plan
3. **Updating plans**: Use `/iterate-plan HAN-123` to modify plans
4. **Verification**: Use `/validate-plan HAN-123` to verify implementation

The planning skills will read your Linear configuration from `.claude/config.json` automatically.
