---
name: iterate-plan
description: Update existing implementation plans based on feedback
model: opus
---

# Iterate Implementation Plan

Update existing implementation plans in issue tracker tickets based on user feedback. Be skeptical, thorough, and ensure changes are grounded in actual codebase reality.

## Prerequisites

This skill requires:
1. A configured issue tracker (run `/init-tracker` if not set up)
2. The tracker's MCP tools to be available

## Configuration

Read from `.claude/config.json`:
- `tracker.type` - Which tracker (linear, jira)
- `project.commands` - For success criteria commands

## Initial Response

When invoked:

1. **Read config** from `.claude/config.json`

2. **Parse the input** to identify:
   - Ticket ID (e.g., ABC-123)
   - Requested changes/feedback

3. **Handle different scenarios**:

   **If NO ticket ID provided**:
   ```
   I'll help you iterate on an existing implementation plan.

   Which ticket would you like to update? Please provide the ticket ID.
   ```
   Then list recent tickets from the configured tracker.

   **If ticket ID provided but NO feedback**:
   ```
   I've found the plan in [ticket ID]. What changes would you like to make?

   For example:
   - "Add a phase for migration handling"
   - "Update the success criteria to include performance tests"
   - "Adjust the scope to exclude feature X"
   - "Split Phase 2 into two separate phases"
   ```

   **If BOTH ticket ID AND feedback provided**:
   Proceed immediately to Step 1

## Process Steps

### Step 1: Read and Understand Current Plan

1. **Fetch the ticket** using the configured tracker tools

2. **Understand the current structure**:
   - Phases and their scope
   - Success criteria
   - Implementation approach

3. **Understand the requested changes**:
   - What the user wants to add/modify/remove
   - Whether changes require codebase research
   - Scope of the update

### Step 2: Research If Needed

**Only research if changes require new technical understanding.**

If the feedback requires understanding new code patterns:

1. **Use the Explore agent** to:
   - Find relevant files for the new requirements
   - Understand implementation details
   - Find similar patterns to follow

2. **Read any new files** identified fully into context

3. **Cross-reference** with the plan requirements

### Step 3: Present Understanding and Approach

Before making changes, confirm your understanding:

```
Based on your feedback, I understand you want to:
- [Change 1 with specific detail]
- [Change 2 with specific detail]

My research found:
- [Relevant code pattern or constraint]
- [Important discovery that affects the change]

I plan to update the plan by:
1. [Specific modification to make]
2. [Another modification]

Does this align with your intent?
```

Get user confirmation before proceeding.

### Step 4: Update the Plan

1. **Prepare the updated description** with focused, precise changes:
   - Maintain the existing structure unless explicitly changing it
   - Keep all file:line references accurate
   - Update success criteria if needed
   - Use commands from config for verification steps

2. **Update the ticket** using tracker-specific tools

3. **Add a comment** documenting the changes:
   ```
   Plan Updated

   Changes made:
   - [Specific change 1]
   - [Specific change 2]

   Reason: [User's feedback summary]
   ```

### Step 5: Review

1. **Present the changes made**:
   ```
   I've updated the plan in [ticket URL]

   Changes made:
   - [Specific change 1]
   - [Specific change 2]

   The updated plan now:
   - [Key improvement]
   - [Another improvement]

   Would you like any further adjustments?
   ```

2. **Be ready to iterate further** based on feedback

## Tracker-Specific Operations

### For Linear
```
# Fetch ticket
mcp__linear-server__get_issue with id: [ticket ID]

# Update ticket
mcp__linear-server__update_issue with id, description: [updated plan]

# Add comment
mcp__linear-server__create_comment with issueId, body
```

### For Jira (future)
```
# Similar operations with mcp__jira__* tools
```

## Important Guidelines

1. **Be Skeptical**: Don't blindly accept change requests that seem problematic
2. **Be Surgical**: Make precise edits, not wholesale rewrites
3. **Be Thorough**: Research code patterns if changes require new understanding
4. **Be Interactive**: Confirm understanding before making changes
5. **No Open Questions**: Resolve questions before updating the plan

## Success Criteria Guidelines

When updating success criteria, maintain the two-category structure:

1. **Automated Verification**:
   - Use commands from `project.commands` in config
   - Specific files that should exist
   - Code compilation/type checking

2. **Manual Verification**:
   - UI/UX functionality
   - Performance under real conditions
   - Edge cases that are hard to automate
   - User acceptance criteria

## Example Interaction Flows

**Scenario 1: User provides everything upfront**
```
User: /iterate-plan ABC-123 - add phase for database migration
Assistant: [Fetches ticket, researches migration patterns, updates plan]
```

**Scenario 2: User provides just ticket ID**
```
User: /iterate-plan ABC-123
Assistant: I've found the plan. What changes would you like to make?
User: Split Phase 2 into backend and frontend phases
Assistant: [Proceeds with update]
```

**Scenario 3: User provides no arguments**
```
User: /iterate-plan
Assistant: Which ticket would you like to update? [Lists recent tickets]
```
