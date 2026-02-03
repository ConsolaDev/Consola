---
name: research-codebase
description: Conduct comprehensive codebase research with parallel sub-agents. Use when user asks to "research codebase", "analyze code", "investigate", "understand the code", "how does X work", or wants to document how existing code functions.
---

# Research Codebase

Conduct comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

## Critical Constraint

**Your only job is to document and explain the codebase as it exists today.**

- DO NOT suggest improvements or changes unless explicitly asked
- DO NOT perform root cause analysis unless explicitly asked
- DO NOT propose future enhancements unless explicitly asked
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Initial Setup

When invoked, respond:
```
I'm ready to research the codebase. Please provide your research question or area of interest, and I'll analyze it thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query.

## Process

### Step 1: Read Mentioned Files First

- If user mentions specific files, read them FULLY using Read without limit/offset
- Read these files yourself in main context before spawning any sub-tasks
- This ensures you have full context before decomposing the research

### Step 2: Analyze and Decompose

- Break down the query into composable research areas
- Think about underlying patterns, connections, and architectural implications
- Identify specific components, patterns, or concepts to investigate
- Create a research plan using TodoWrite to track subtasks
- Consider which directories, files, or patterns are relevant

### Step 3: Spawn Parallel Research Tasks

Create multiple Task agents to research different aspects concurrently:

- **Locator tasks**: Find WHERE files and components live
- **Analyzer tasks**: Understand HOW specific code works (without critiquing)
- **Pattern finder tasks**: Find examples of existing patterns (without evaluating)

**All agents are documentarians, not critics.** They describe what exists without suggesting improvements.

Key principles:
- Start with locator tasks to find what exists
- Then use analyzer tasks on promising findings to document how they work
- Run multiple agents in parallel when searching for different things
- Request specific file:line references in responses
- Remind agents they are documenting, not evaluating

### Step 4: Synthesize Findings

**Wait for ALL sub-agent tasks to complete** before proceeding.

- Compile all sub-agent results
- Prioritize live codebase findings as primary source of truth
- Connect findings across different components
- Include specific file paths and line numbers
- Highlight patterns, connections, and architectural decisions
- Answer user's specific questions with concrete evidence

### Step 5: Generate Research Document

Write to `./research/YYYY-MM-DD-description.md`:

```markdown
---
date: [ISO format with timezone]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
topic: "[User's Question/Topic]"
tags: [research, codebase, relevant-components]
status: complete
---

# Research: [User's Question/Topic]

**Date**: [Current date and time with timezone]
**Git Commit**: [Current commit hash]
**Branch**: [Current branch name]
**Repository**: [Repository name]

## Research Question
[Original user query]

## Summary
[High-level documentation of what was found, describing what exists]

## Detailed Findings

### [Component/Area 1]
- Description of what exists ([file.ext:line](link))
- How it connects to other components
- Current implementation details (without evaluation)

### [Component/Area 2]
...

## Code References
- `path/to/file.py:123` - Description of what's there
- `another/file.ts:45-67` - Description of the code block

## Architecture Documentation
[Current patterns, conventions, and design implementations]

## Open Questions
[Any areas that need further investigation]
```

### Step 6: Add GitHub Permalinks (Optional)

If on main branch or commit is pushed:
- Get repo info: `gh repo view --json owner,name`
- Create permalinks: `https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`
- Replace local references with permalinks

### Step 7: Present Findings

- Present a concise summary to the user
- Include key file references for easy navigation
- Ask if they have follow-up questions

### Step 8: Handle Follow-ups

If user has follow-up questions:
- Append to the same research document
- Add new section: `## Follow-up Research [timestamp]`
- Spawn new sub-agents as needed

## Guidelines

- Always use parallel Task agents to maximize efficiency
- Always run fresh codebase research - never rely solely on existing documents
- Focus on concrete file paths and line numbers
- Research documents should be self-contained
- Each sub-agent prompt should be focused on read-only documentation
- Document cross-component connections
- Include temporal context (when research was conducted)
- **You and all sub-agents are documentarians, not evaluators**
- **Document what IS, not what SHOULD BE**
