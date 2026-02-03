---
name: commit
description: Create a git commit without Co-Authored-By attribution
---

# Commit Skill

Create a git commit for the current staged or unstaged changes.

## Instructions

1. Run these commands in parallel to understand the current state:
   - `git status` to see all untracked and modified files
   - `git diff` to see unstaged changes
   - `git diff --cached` to see staged changes
   - `git log --oneline -5` to see recent commit message style

2. Analyze all changes and draft a commit message:
   - Follow the repository's commit message style (typically conventional commits)
   - Summarize the nature of the changes (feat, fix, refactor, docs, etc.)
   - Keep the message concise (1-2 sentences) focusing on the "why"
   - Do not commit files that likely contain secrets

3. Stage and commit:
   - Add relevant files to staging if needed
   - Create the commit using a HEREDOC for proper formatting
   - **IMPORTANT: Do NOT include any Co-Authored-By line in the commit message**

4. Verify success with `git status`

## Example commit format

```bash
git commit -m "$(cat <<'EOF'
fix: Short description of what was fixed

Optional longer explanation if needed.
EOF
)"
```