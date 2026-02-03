---
name: validate-plan
description: Validate implementation against plan, verify success criteria, identify issues
---

# Validate Plan

Validate that an implementation plan was correctly executed, verify all success criteria, and identify any deviations or issues.

## Prerequisites

This skill requires:
1. A configured issue tracker (run `/init-tracker` if not set up)
2. The tracker's MCP tools to be available

## Configuration

Read from `.claude/config.json`:
- `tracker.type` - Which tracker (linear, jira)
- `tracker.statuses` - For status transitions
- `project.commands` - For running verification commands

## Getting Started

When invoked with a ticket ID (e.g., `/validate-plan ABC-123`):

1. **Read config** from `.claude/config.json`
2. **Fetch the ticket** using the configured tracker tools
3. **Read the full plan** from the ticket description
4. **Gather implementation evidence** from git and codebase

If starting fresh without context of the implementation:
```bash
# Check recent commits
git log --oneline -n 20

# Run comprehensive checks using commands from config
[project.commands.build]
[project.commands.test]
```

If no ticket ID provided, ask for one or check recent "In Review" tickets.

## Validation Process

### Step 1: Context Discovery

1. **Read the implementation plan** completely from the ticket
2. **Identify what should have changed**:
   - List all files that should be modified
   - Note all success criteria (automated and manual)
   - Identify key functionality to verify

3. **Use the Explore agent** to discover implementation:
   - Verify database migrations were added correctly
   - Compare actual changes to plan specifications
   - Check if tests were added/modified as specified

### Step 2: Systematic Validation

For each phase in the plan:

1. **Check completion status**:
   - Look for completion comments in the ticket
   - Verify the actual code matches claimed completion

2. **Run automated verification** using commands from config:
   - Execute each command from "Automated Verification"
   - Document pass/fail status
   - If failures, investigate root cause

3. **List manual criteria**:
   - What needs manual testing
   - Provide clear steps for user verification

4. **Think about edge cases**:
   - Were error conditions handled?
   - Are there missing validations?
   - Could the implementation break existing functionality?

### Step 3: Generate Validation Report

Create a comprehensive validation summary and add it as a comment to the ticket:

**Report Template:**

```markdown
## Validation Report

### Implementation Status
- [x] Phase 1: [Name] - Fully implemented
- [x] Phase 2: [Name] - Fully implemented
- [ ] Phase 3: [Name] - Partially implemented (see issues)

### Automated Verification Results
- [x] Build passes: `[build command]`
- [x] Tests pass: `[test command]`
- [ ] Specific test: [issue details]

### Code Review Findings

#### Matches Plan:
- Database migration correctly adds [table/column]
- API implements specified endpoints
- Service layer follows plan

#### Deviations from Plan:
- Used different approach in [file:line] - [explanation]
- Added extra validation in [file:line] (improvement)

#### Potential Issues:
- [Issue 1]
- [Issue 2]

### Manual Testing Required:
1. Functionality:
   - [ ] [Specific test to perform]
   - [ ] Expected result: [what should happen]

2. Edge cases:
   - [ ] Test with invalid input
   - [ ] Test authorization

### Recommendations:
- [Action item 1]
- [Action item 2]
```

### Step 4: Update Ticket Status

Based on validation results:

**If all criteria pass:**
Update ticket status to "done" (use status from config)

**If issues found:**
Keep in "inReview" status and list issues for resolution.

## Tracker-Specific Operations

### For Linear
```
# Fetch ticket
mcp__linear-server__get_issue with id: [ticket ID]

# Add validation comment
mcp__linear-server__create_comment with issueId, body: [report]

# Update status
mcp__linear-server__update_issue with id, state: [status from config]
```

### For Jira (future)
```
# Similar operations with mcp__jira__* tools
```

## Validation Checklist

Always verify:
- [ ] All phases marked complete are actually done
- [ ] Automated tests pass
- [ ] Code follows existing patterns
- [ ] No regressions introduced
- [ ] Error handling is robust
- [ ] Schema/API matches implementation

## Working with Existing Context

If you were part of the implementation:
- Review the conversation history
- Focus validation on work done in this session
- Be honest about any shortcuts or incomplete items

## Important Guidelines

1. **Be thorough but practical** - Focus on what matters
2. **Run all automated checks** - Don't skip verification commands
3. **Document everything** - Both successes and issues
4. **Think critically** - Question if the implementation truly solves the problem
5. **Consider maintenance** - Will this be maintainable long-term?

## Relationship to Other Commands

Recommended workflow:
1. `/create-plan` - Create the implementation plan
2. `/implement-plan` - Execute the implementation
3. `/validate-plan` - Verify implementation correctness
4. `/commit` - Create atomic commits for changes

The validation works best after implementation is complete, as it can analyze what was built against what was planned.
