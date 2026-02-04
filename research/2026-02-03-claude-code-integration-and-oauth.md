---
date: 2026-02-03T12:00:00-08:00
git_commit: 3654a163085ab4f93a124ec476db97c5bb03b48d
branch: master
repository: consola
topic: "Claude Code Integration and OAuth Authentication for UI Wrapper"
tags: [research, codebase, claude-code, oauth, electron, integration]
status: complete
---

# Research: Claude Code Integration and OAuth Authentication for UI Wrapper

**Date**: 2026-02-03
**Git Commit**: 3654a163085ab4f93a124ec476db97c5bb03b48d
**Branch**: master
**Repository**: consola

## Research Question

Is there a way to use Claude Code internally in the application to perform operations while having a UI on top of it? How can we use their OAuth flow for authentication to avoid external API keys? The goal is to build a UI that spawns Claude agents and provides UI for commands, skills, MCP connections, etc., leveraging Claude Code as a base instead of re-implementing features.

## Summary

**Yes, this is feasible** but with important constraints:

1. **Integration Options**: You can integrate Claude Code via:
   - **Claude Agent SDK** (TypeScript/Python) - Full programmatic control
   - **CLI with `-p` flag** - Headless/non-interactive mode with JSON streaming
   - **MCP Protocol** - Claude Code can act as an MCP server

2. **OAuth Limitation**: Anthropic has **blocked third-party applications** from using OAuth tokens as of January 2026. OAuth tokens only work within Claude Code itself. Your application would need to either:
   - Use the Claude Agent SDK (which is allowed)
   - Have users provide their own API keys
   - Run Claude Code as a subprocess and parse its output

3. **Current Architecture Alignment**: Your app already has the infrastructure (PTY, mode switching, IPC) to spawn and communicate with Claude Code.

---

## Detailed Findings

### 1. Current Application Architecture

Your Electron app already has excellent foundations for Claude Code integration:

**Tech Stack:**
- Electron v28.0.0 with React v19.2.4
- XTerm.js v6.0.0 for terminal emulation
- node-pty v1.0.0 for pseudo-terminal spawning
- Zustand for state management
- Radix UI for components

**Key Architecture:**
- `src/main/TerminalService.ts:80-135` - Already implements dual PTY architecture with shell/claude mode switching
- `src/main/TerminalService.ts:107-135` - Spawns `claude` command and handles its lifecycle
- `src/shared/types.ts:1-4` - Defines `TerminalMode` enum with SHELL and CLAUDE modes
- `src/renderer/stores/terminalStore.ts:1-34` - Zustand store for mode and connection state

**Current Claude Integration:**
```typescript
// From TerminalService.ts - already spawns Claude Code
initClaude() {
  this.claudePty = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cwd: this.currentWorkingDirectory,
    env: process.env as { [key: string]: string }
  });
}
```

---

### 2. Claude Code Programmatic Integration Methods

#### 2.1 Claude Agent SDK (Recommended)

The **Claude Agent SDK** is the official way to embed Claude Code capabilities programmatically.

**TypeScript Installation:**
```bash
npm install @anthropic-ai/claude-agent-sdk
```

**Basic Usage:**
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: {
    allowedTools: ["Read", "Edit", "Bash"],
    maxTurns: 10
  }
})) {
  if ("result" in message) {
    // Handle final result
    console.log(message.result);
  } else if (message.type === "tool_use") {
    // Handle tool usage events
    updateUI(message);
  }
}
```

**Key SDK Features:**
| Feature | Description |
|---------|-------------|
| Streaming responses | Real-time updates via async iterators |
| Tool control | Specify allowed tools, hook into tool calls |
| Subagents | Define specialized agents for different tasks |
| Session management | Resume conversations with session IDs |
| Custom MCP tools | Add your own tools via in-process MCP servers |

**Custom Tools Example:**
```typescript
import { tool, create_sdk_mcp_server } from "@anthropic-ai/claude-agent-sdk";

const myTool = tool("notify-user", "Show notification to user", {
  message: { type: "string" }
}, async (args) => {
  showNotification(args.message); // Your UI notification
  return { content: [{ type: "text", text: "Notification shown" }] };
});

const mcpServer = create_sdk_mcp_server({
  name: "ui-tools",
  version: "1.0.0",
  tools: [myTool]
});
```

#### 2.2 CLI Headless Mode

Run Claude Code non-interactively with structured output:

```bash
# JSON output for parsing
claude -p "What does this function do?" --output-format json

# Streaming JSON for real-time UI updates
claude -p "Refactor this code" --output-format stream-json --verbose

# With tool permissions
claude -p "Fix the tests" --allowedTools "Read,Edit,Bash"
```

**CLI Flags for UI Integration:**
| Flag | Purpose |
|------|---------|
| `-p, --print` | Non-interactive mode |
| `--output-format json` | Structured JSON output |
| `--output-format stream-json` | Real-time streaming JSON |
| `--allowedTools` | Pre-approve specific tools |
| `--max-turns` | Limit agent iterations |
| `--max-budget-usd` | Set spending limits |
| `-c, --continue` | Continue last conversation |
| `-r, --resume` | Resume specific session |
| `--mcp-config` | Load MCP server config |

#### 2.3 Claude Code as MCP Server

Claude Code can expose its tools to other applications:

```bash
claude mcp serve
```

This allows your app to connect to Claude Code via MCP protocol and use its tools.

---

### 3. OAuth Authentication - Critical Limitation

#### The Policy Change

As of **January 2026**, Anthropic **blocked third-party applications** from using OAuth tokens:

> "This credential is only authorized for use with Claude Code and cannot be used for other API requests"

**Impact:**
- OAuth tokens from `claude.ai/oauth/authorize` only work within official Claude Code
- Third-party tools attempting to use these tokens receive authentication errors
- This affects tools like OpenCode, Crush, and any custom implementations

#### OAuth Technical Details (For Reference)

**Endpoints:**
- Authorization: `https://claude.ai/oauth/authorize`
- Token Exchange: `https://console.anthropic.com/v1/oauth/token`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`

**Token Types:**
- Access Token: `sk-ant-oat01-...` (8 hours expiry)
- Refresh Token: `sk-ant-ort01-...` (indefinite)

**Flow:** OAuth 2.0 with PKCE (Proof Key for Code Exchange)

#### Workarounds for Authentication

1. **Use Claude Agent SDK** (Recommended)
   - SDK handles authentication internally
   - Users authenticate via their local Claude Code installation
   - No need to manage OAuth tokens yourself

2. **API Key Authentication**
   - Users provide `ANTHROPIC_API_KEY`
   - Works with credit-based billing
   - Set via environment variable

3. **Subprocess Approach**
   - Spawn Claude Code CLI as subprocess
   - Let it handle its own authentication
   - Parse streaming JSON output

---

### 4. Integration Architecture Recommendations

#### Option A: SDK-First Architecture (Recommended)

```
┌─────────────────────────────────────────────┐
│                 Electron App                 │
├─────────────────────────────────────────────┤
│  Renderer (React UI)                        │
│  ├── Chat Interface                         │
│  ├── Tool Status Display                    │
│  ├── MCP Connection Manager                 │
│  └── Skill/Command Panels                   │
├─────────────────────────────────────────────┤
│  Main Process                               │
│  ├── Claude Agent SDK Integration           │
│  │   ├── query() for conversations          │
│  │   ├── Tool hooks for UI updates          │
│  │   └── Custom MCP tools for UI actions    │
│  ├── Session Management                     │
│  └── IPC Bridge to Renderer                 │
└─────────────────────────────────────────────┘
```

**Pros:**
- Full programmatic control
- Real-time streaming events
- Custom tool integration
- Session continuity

**Cons:**
- More complex implementation
- Must handle authentication

#### Option B: CLI Wrapper Architecture

```
┌─────────────────────────────────────────────┐
│                 Electron App                 │
├─────────────────────────────────────────────┤
│  Renderer (React UI)                        │
│  ├── Terminal Display (XTerm)               │
│  ├── Structured Output Parser               │
│  └── Mode Controls                          │
├─────────────────────────────────────────────┤
│  Main Process                               │
│  ├── PTY with Claude CLI                    │
│  │   claude -p "..." --output-format        │
│  │         stream-json --verbose            │
│  ├── JSON Stream Parser                     │
│  └── Event Extraction                       │
└─────────────────────────────────────────────┘
```

**Pros:**
- Simpler implementation
- Uses existing TerminalService
- Authentication handled by CLI

**Cons:**
- Less control over internals
- Parsing complexity
- Limited tool customization

#### Option C: Hybrid Architecture

Combine both approaches:
- Use SDK for structured operations (file edits, searches)
- Use PTY/CLI for interactive sessions
- Share authentication state

---

### 5. Features You Can Expose via UI

Based on Claude Code's capabilities, here's what your UI could provide:

#### Commands
| Command | UI Component |
|---------|--------------|
| `/clear` | Clear button |
| `/compact` | Memory management panel |
| `/config` | Settings modal |
| `/cost` | Usage dashboard |
| `/export` | Export button/menu |
| `/mcp` | MCP server manager |
| `/memory` | CLAUDE.md editor |
| `/model` | Model selector dropdown |
| `/permissions` | Permissions panel |
| `/plan` | Plan mode toggle |
| `/resume` | Session browser |

#### Skills System
- Display available skills from `.claude/skills/`
- Skill browser and search
- Skill editor for creating custom skills
- Skill invocation buttons

#### MCP Connections
- Server connection status
- Add/remove MCP servers
- Tool discovery from connected servers
- Connection logs

#### Tool Status
- Real-time tool usage display
- Permission approval UI
- Tool output preview
- Execution history

---

### 6. Implementation Steps

1. **Install Claude Agent SDK**
   ```bash
   npm install @anthropic-ai/claude-agent-sdk
   ```

2. **Create SDK Service** (new file: `src/main/ClaudeService.ts`)
   ```typescript
   import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

   export class ClaudeService {
     async *executeQuery(prompt: string, options?: ClaudeAgentOptions) {
       for await (const message of query({ prompt, options })) {
         yield message;
       }
     }
   }
   ```

3. **Add IPC Handlers for SDK Events**
   ```typescript
   // In ipc-handlers.ts
   ipcMain.handle('claude:query', async (event, prompt, options) => {
     const results = [];
     for await (const msg of claudeService.executeQuery(prompt, options)) {
       mainWindow.webContents.send('claude:message', msg);
       results.push(msg);
     }
     return results;
   });
   ```

4. **Build UI Components**
   - Chat interface for conversations
   - Tool status sidebar
   - MCP connection manager
   - Settings panels

5. **Handle Authentication**
   - Check for existing Claude Code authentication
   - Provide API key input as fallback
   - Store credentials securely in Keychain

---

## Code References

- `src/main/TerminalService.ts:107-135` - Current Claude PTY spawning
- `src/main/TerminalService.ts:51-67` - Mode switching implementation
- `src/main/ipc-handlers.ts:38-50` - IPC handler patterns
- `src/preload/preload.ts:1-67` - Context bridge API exposure
- `src/renderer/stores/terminalStore.ts:1-34` - State management patterns
- `src/shared/constants.ts:1-24` - IPC channel definitions

---

## External Resources

### Official Documentation
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Code Headless Mode](https://code.claude.com/docs/en/headless)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [Claude Code Skills Documentation](https://code.claude.com/docs/en/skills)

### Repositories
- [Claude Code GitHub](https://github.com/anthropics/claude-code)
- [Claude Agent SDK (Python)](https://github.com/anthropics/claude-agent-sdk-python)
- [Claude Agent SDK Demos](https://github.com/anthropics/claude-agent-sdk-demos)

### NPM Packages
- [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)

---

## Key Findings Summary

| Question | Answer |
|----------|--------|
| Can we use Claude Code internally? | **Yes**, via Claude Agent SDK or CLI subprocess |
| Can we use OAuth to avoid API keys? | **No**, OAuth tokens are restricted to official Claude Code only |
| Best integration approach? | **Claude Agent SDK** for full control, or CLI with `--output-format stream-json` for simpler implementation |
| Can we build UI for commands/skills/MCP? | **Yes**, all features are accessible programmatically |

---

## Open Questions

1. **SDK Authentication**: How does the Claude Agent SDK handle authentication - does it reuse Claude Code's credentials?

2. **Rate Limits**: What are the rate limits when using SDK vs direct CLI vs OAuth?

3. **Enterprise Support**: Does Anthropic offer enterprise OAuth integration for approved partners?

4. **MCP Server Mode**: When Claude Code runs as MCP server (`claude mcp serve`), how does client authentication work?
