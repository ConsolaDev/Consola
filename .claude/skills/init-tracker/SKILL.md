---
name: init-tracker
description: Initialize or update the project's issue tracker configuration
---

# Initialize Tracker

Set up or update the issue tracker configuration for this project. This creates/updates `.claude/config.json` with tracker-specific settings.

## Usage

```
/init-tracker              # Interactive setup
/init-tracker linear       # Set up Linear integration
/init-tracker jira         # Set up Jira integration (future)
```

## Process

### 1. Check for Existing Config

First, check if `.claude/config.json` exists:
- If exists, offer to update or reconfigure
- If not, create new configuration

### 2. Detect Available Tracker

Check which tracker MCP tools are available:
- Linear: Look for `mcp__linear-server__*` tools
- Jira: Look for `mcp__jira__*` tools (future)

If no tracker tools found:
```
No issue tracker tools detected. Please ensure you have configured an MCP server for your tracker.

For Linear: Add the Linear MCP server to your configuration
For Jira: Add the Jira MCP server to your configuration (coming soon)

Run /mcp to check available integrations.
```

### 3. For Linear Setup

1. **List teams** and let user select:
   ```
   mcp__linear-server__list_teams
   ```
   Present teams and ask user to select one.

2. **Get team statuses**:
   ```
   mcp__linear-server__list_issue_statuses with team selected
   ```

3. **Get team labels**:
   ```
   mcp__linear-server__list_issue_labels with team selected
   ```

4. **Map statuses to workflow stages**:
   Ask user to map their statuses to standard stages:
   - backlog
   - todo
   - inProgress
   - inReview
   - done
   - canceled

5. **Detect project settings**:
   - Look for build files (build.gradle, package.json, Makefile, etc.)
   - Infer language and framework
   - Set appropriate build/test commands

6. **Write configuration** to `.claude/config.json`

### 4. Configuration Schema

```json
{
  "tracker": {
    "type": "linear|jira",
    "team": {
      "name": "Team Name",
      "id": "team-uuid"
    },
    "statuses": {
      "backlog": { "name": "Status Name", "id": "status-id" },
      "todo": { "name": "Status Name", "id": "status-id" },
      "inProgress": { "name": "Status Name", "id": "status-id" },
      "inReview": { "name": "Status Name", "id": "status-id" },
      "done": { "name": "Status Name", "id": "status-id" },
      "canceled": { "name": "Status Name", "id": "status-id" }
    },
    "labels": {
      "feature": { "name": "Label Name", "id": "label-id" },
      "improvement": { "name": "Label Name", "id": "label-id" },
      "bug": { "name": "Label Name", "id": "label-id" }
    },
    "defaultPriority": 3
  },
  "project": {
    "name": "Project Name",
    "language": "kotlin|typescript|python|go|etc",
    "framework": "spring-boot|nextjs|django|etc",
    "commands": {
      "build": "command to build",
      "test": "command to run tests",
      "testSpecific": "command prefix for specific tests",
      "run": "command to run the app",
      "migrate": "command for database migrations (optional)"
    }
  }
}
```

### 5. Verify Configuration

After creating config:
1. Read back the config file
2. Show summary to user
3. Suggest next steps:
   ```
   Configuration saved to .claude/config.json

   Tracker: Linear (Team: [name])
   Project: [name] ([language]/[framework])

   You can now use:
   - /create-plan - Create implementation plans
   - /implement-plan [ID] - Implement a planned ticket
   - /linear - Direct Linear operations

   To reconfigure, run /init-tracker again.
   ```

## Project Detection Logic

### Language Detection
| File | Language |
|------|----------|
| build.gradle.kts, build.gradle | Kotlin/Java |
| package.json | TypeScript/JavaScript |
| requirements.txt, pyproject.toml | Python |
| go.mod | Go |
| Cargo.toml | Rust |
| Gemfile | Ruby |

### Framework Detection
| Indicator | Framework |
|-----------|-----------|
| spring-boot in build.gradle | Spring Boot |
| next in package.json | Next.js |
| react in package.json | React |
| django in requirements | Django |
| fastapi in requirements | FastAPI |

### Default Commands by Stack
| Stack | Build | Test | Run |
|-------|-------|------|-----|
| Gradle | `./gradlew build` | `./gradlew test` | `./gradlew bootRun` |
| npm/yarn | `npm run build` | `npm test` | `npm run dev` |
| Python | `pip install -e .` | `pytest` | `python -m app` |
| Go | `go build ./...` | `go test ./...` | `go run .` |
| Make | `make build` | `make test` | `make run` |
