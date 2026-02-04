---
name: fix-bug
description: |
  Debug and fix bugs in the codebase. Use when the user reports an error, exception, or unexpected behavior.

  Triggers: error messages, stack traces, "fix this bug", "debug this", "why is X not working",
  "getting an error", "this is broken", "X throws an exception", "X crashes", "investigate this issue",
  "something's wrong with", "help me debug", "troubleshoot this", "X doesn't work", "X fails",
  "fix this issue", "resolve this error", "what's causing this", "why does X fail".
---

# Fix Bug

Debug and fix bugs through systematic investigation, with complexity-based planning.

## Workflow

### 1. Understand the Problem

Gather information about the bug:
- Error message and stack trace (if provided)
- Steps to reproduce
- Expected vs actual behavior
- When it started happening (recent changes?)

If the user provides a stack trace, identify the file and line number as the starting point.

### 2. Research the Cause

Investigate the codebase to find the root cause:

**For simple bugs** (clear stack trace pointing to obvious issue):
- Read the file at the error location
- Trace the immediate cause

**For complex bugs** (unclear cause, multiple files involved):
- Use `/research-codebase` skill to spawn parallel agents
- Investigate related files, recent changes, and dependencies

### 3. Assess Complexity

Determine if a plan is needed based on:

| Complexity | Criteria | Action |
|------------|----------|--------|
| **Simple** | Single file, < 10 lines changed, obvious fix | Fix directly |
| **Medium** | 2-3 files, clear solution but multiple changes | Brief explanation, then fix |
| **Complex** | 4+ files, architectural changes, unclear solution | Use `/create-plan` skill first |

### 4. Propose the Fix

Present the fix to the user:

```
## Bug Analysis

**Cause**: [Root cause explanation]
**Location**: [file:line references]

## Proposed Fix

[Explain what changes are needed and why]

**Files to modify**:
- `path/to/file.ts` - [change description]

Ready to apply this fix?
```

Wait for user approval before making changes.

### 5. Apply the Fix

After user approves:
- Make the code changes
- Run build/lint if applicable to verify no new errors

```
Fix applied. Please test to verify:
1. [Specific test step]
2. [Expected result]

Let me know if the fix works so I can commit it.
```

### 6. Commit

After user confirms the fix works:
- Stage the changed files
- Create a descriptive commit message explaining what was fixed

## Example

**User**: "Getting this error: TypeError: Cannot read property 'map' of undefined at UserList.tsx:25"

**Response**:
1. Read `UserList.tsx` around line 25
2. Identify that `users` array is undefined on first render
3. Propose adding a null check or default value
4. Wait for approval → Apply fix → User tests → Commit
