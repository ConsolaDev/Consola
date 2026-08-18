---
date: 2026-02-17T12:00:00+01:00
git_commit: fbec51e
branch: main
repository: console-1
topic: "Platform Architecture Migration: From Electron Desktop to Multi-Repo Agent Orchestration Platform"
tags: [research, codebase, architecture, migration, platform, backend, agent-orchestration]
status: complete
---

# Research: Platform Architecture Migration Analysis

**Date**: 2026-02-17
**Git Commit**: fbec51e
**Branch**: main
**Repository**: console-1

## Research Question

Given the vision to transform Consola from a single-user Electron desktop app into a deployable agent orchestration platform (local or on-premise), how should we architect the transition? The target platform must support:
- Multi-repository fleet management
- Teams of agents orchestration
- Integrations (Slack, GitHub, CI/CD, observability)
- Time-based recurrent agents
- Fleet-wide changes across repositories
- Self-hosted / on-premise deployment with full control
- OpenClaw-inspired philosophical principles (local-first, self-hosted, user-controlled)

## Summary

After thorough analysis of the current Consola codebase (~116 TypeScript files, 8 Zustand stores, 50+ IPC channels, 5 bridge services), the **recommended approach is to create a new monorepo project** that extracts reusable pieces from Consola while building the platform layer from scratch. The current codebase is well-architected for a desktop app but the scope difference is so fundamental that retrofitting would create more technical debt than starting fresh with proper architecture.

---

## Part 1: Current Codebase Assessment

### Architecture Overview

Consola is a three-process Electron application:

```
src/main/           → Electron main process (Node.js, CommonJS output)
src/preload/        → Context bridge (exposes APIs to renderer)
src/renderer/       → React 19 frontend (Vite, ESM)
src/shared/         → Shared types and IPC channel constants
```

### What Exists Today

| Component | Files | Lines (est.) | Electron Coupling | Extractable |
|-----------|-------|-------------|-------------------|-------------|
| ClaudeAgentService | 1 | ~500 | **None** | 95% |
| SessionDatabase (SQLite) | 1 | ~280 | 5% (app.getPath) | 98% |
| SessionStorageService | 1 | ~60 | None | 100% |
| SessionNameGenerator | 1 | ~50 | None | 100% |
| TerminalService | 1 | ~200 | None | 100% |
| MediaStorageService | 1 | ~180 | 20% (nativeImage) | 80% |
| Git operations (in ipc-handlers) | inline | ~430 | None | 100% |
| IPC Handlers (routing) | 1 | ~820 | 100% | 0% |
| Window Manager | 1 | ~50 | 100% | 0% |
| React Frontend | ~100 | ~15,000 | Moderate via bridges | 70% |
| Bridge Services | 5 | ~300 | 100% (purpose) | 0% (replace) |
| Zustand Stores | 8 | ~2,500 | Low-Moderate | 80% |

### Key Finding: The Bridge Pattern Enables Migration

The codebase's strongest architectural decision is the **bridge service pattern**. All Electron IPC access is isolated in 5 bridge files:
- `agentBridge.ts` — Agent operations
- `fileBridge.ts` — File system access
- `gitBridge.ts` — Git operations
- `dialogBridge.ts` — Native dialogs
- `sessionStorageBridge.ts` — Session persistence

**This means the entire React frontend can be ported to web** by replacing these 5 files with HTTP/WebSocket clients. The UI components themselves have zero direct Electron coupling.

### Business Logic Already Extractable

The most critical service — `ClaudeAgentService.ts` — has **zero Electron dependencies**. It uses Node.js `EventEmitter`, the Claude Agent SDK, and nothing else. This is the core of the agent orchestration and it's already portable.

---

## Part 2: OpenClaw / MoltBolt Philosophical Principles

The OpenClaw project embodies these principles that should guide our platform:

| Principle | OpenClaw Implementation | Our Adaptation |
|-----------|------------------------|----------------|
| **Self-hosted only** | Loopback-only binding, no cloud dependency | Backend runs locally or on-premise, never SaaS |
| **Local-first** | Local WebSocket control plane (ws://127.0.0.1) | All data stays on your infrastructure |
| **User controls everything** | Single-user focus, all config local | Admin controls all repos, agents, integrations |
| **Untrusted-by-default** | Treats external input as adversarial | Permission model for agent actions, audit trails |
| **Channel agnostic** | Routes from WhatsApp/Slack/Discord through unified infra | Integrations as plugins, unified agent layer |
| **Skills-first extensibility** | Bundled + workspace-scoped skills | Plugin system for tools, integrations, workflows |
| **Pragmatic transparency** | Usage tracking, session pruning, failover | Full observability, cost tracking, logging |
| **Minimal control plane** | One WebSocket, no external orchestration | Single backend binary, simple deployment |

---

## Part 3: Recommendation — New Monorepo Project

### Why a New Project?

The scope difference between "desktop AI chat app" and "enterprise agent orchestration platform" is **orders of magnitude**:

| Dimension | Consola (Current) | Target Platform |
|-----------|-------------------|-----------------|
| Users | 1 (local desktop) | Teams / company-wide |
| Repos | 1 at a time | All repos in the fleet |
| Agents | 1 per session | Teams of teams of agents |
| Deployment | Electron on laptop | Local daemon or on-premise servers |
| Scheduling | None | Time-based recurrent tasks |
| Integrations | None | Slack, GitHub, CI/CD, observability |
| State | SQLite per user | Database with multi-user, multi-repo state |
| Communication | Electron IPC | HTTP/WebSocket/gRPC |

Retrofitting this would mean:
1. Ripping out the Electron shell while keeping React
2. Building an entirely new backend (agents, scheduling, fleet, integrations)
3. New data models (repos, teams, schedules, integrations)
4. New frontend features (fleet dashboard, scheduling UI, integration config)
5. **>80% of new code has no relation to current code**

### What to Extract from Consola

These components should be brought into the new project:

1. **ClaudeAgentService.ts** → Core agent wrapper (already portable)
2. **Agent event types** (`src/shared/types.ts`) → Agent communication contract
3. **React UI components** (selectively):
   - Chat interface (AgentPanel, ChatMessage, ChatInput)
   - Tool rendering (ToolBlock, ToolCluster, ToolOutput)
   - Markdown rendering (MarkdownRenderer, CodeBlock)
   - Diff viewer (DiffView)
   - Code selection system
4. **Zustand stores** (as patterns, not directly):
   - agentStore patterns for multi-instance agent state
   - workspaceStore patterns for hierarchy management

---

## Part 4: Proposed Platform Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Frontend (React)                      │
│   Dashboard │ Fleet View │ Agent Chat │ Scheduling │ Integrations │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / WebSocket
┌──────────────────────────┴──────────────────────────────────────┐
│                      API Gateway / Router                        │
├─────────────────────────────────────���───────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Agent Engine │  │  Scheduler   │  │  Integration Hub    │    │
│  │             │  │              │  │                     │    │
│  │ • Single    │  │ • Cron jobs  │  │ • Slack connector   │    │
│  │ • Teams     │  │ • Recurring  │  │ • GitHub connector  │    │
│  │ • Fleets    │  │ • Triggers   │  │ • CI/CD connector   │    │
│  └─────────────┘  └──────────────┘  │ • Observability     │    │
│                                      │ • Custom plugins    │    │
│  ┌─────────────┐  ┌──────────────┐  └─────────────────────┘    │
│  │ Repo Manager│  │ Permission   │                              │
│  │             │  │ & Auth       │  ┌─────────────────────┐    │
│  │ • Sync      │  │              │  │ Event Bus           │    │
│  │ • Fleet ops │  │ • Trust mode │  │ (Internal messaging)│    │
│  │ • Git ops   │  │ • Audit log  │  └─────────────────────┘    │
│  └─────────────┘  └──────────────┘                              │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                     Data Layer                                   │
│  PostgreSQL/SQLite │ Redis (queues) │ File Storage              │
└─────────────────────────────────────────────────────────────────┘
```

### Monorepo Structure

```
platform/
├── packages/
│   ├── core/                    # Shared types, utilities, constants
│   │   ├── src/
│   │   │   ├── types/          # Agent, repo, schedule, integration types
│   │   │   ├── events/         # Event definitions (agent, system, integration)
│   │   │   └── utils/          # Shared utilities
│   │   └── package.json
│   │
│   ├── agent-engine/            # Core agent orchestration (extracted from Consola)
│   │   ├── src/
│   │   │   ├── ClaudeAgentService.ts    # From Consola (enhanced)
│   │   │   ├── AgentPool.ts             # NEW: Manage agent teams
│   │   │   ├── AgentOrchestrator.ts     # NEW: Coordinate multi-agent workflows
│   │   │   ├── FleetAgent.ts            # NEW: Cross-repo agent operations
│   │   │   ├── PermissionManager.ts     # From Consola trust mode (enhanced)
│   │   │   └── SessionManager.ts        # From Consola (enhanced)
│   │   └── package.json
│   │
│   ├── repo-manager/            # Repository fleet management
│   │   ├── src/
│   │   │   ├── RepoRegistry.ts          # Track all synced repos
│   │   │   ├── RepoSyncService.ts       # Clone/pull/sync repos
│   │   │   ├── GitService.ts            # From Consola git ops (extracted)
│   │   │   ├── FleetOperations.ts       # Cross-repo changes
│   │   │   └── RepoAnalyzer.ts          # Repo metadata, languages, structure
│   │   └── package.json
│   │
│   ├── scheduler/               # Time-based agent scheduling
│   │   ├── src/
│   │   │   ├── SchedulerService.ts      # Cron-like scheduling engine
│   │   │   ├── RecurrentTaskRunner.ts   # Execute scheduled agent tasks
│   │   │   ├── TriggerEngine.ts         # Event-based triggers
│   │   │   └── ScheduleStore.ts         # Persistence for schedules
│   │   └── package.json
│   │
│   ├── integrations/            # External system connectors
│   │   ├── src/
│   │   │   ├── IntegrationHub.ts        # Plugin registry and lifecycle
│   │   │   ├── connectors/
│   │   │   │   ├── SlackConnector.ts
│   │   │   │   ├── GitHubConnector.ts
│   │   │   │   ├── CICDConnector.ts     # Jenkins/GH Actions/CircleCI
│   │   │   │   └── ObservabilityConnector.ts  # Datadog/Grafana/etc
│   │   │   ├── WebhookReceiver.ts       # Inbound webhook handling
│   │   │   └── NotificationService.ts   # Outbound notifications
│   │   └── package.json
│   │
│   ├── database/                # Data access layer
│   │   ├── src/
│   │   │   ├── migrations/     # Schema migrations
│   │   │   ├── models/         # ORM models
│   │   │   │   ├── Agent.ts
│   │   │   │   ├── Repository.ts
│   │   │   │   ├── Schedule.ts
│   │   │   │   ├── Session.ts
│   │   │   │   ├── Integration.ts
│   │   │   │   └── AuditLog.ts
│   │   │   └── DatabaseService.ts
│   │   └── package.json
│   │
│   └── ui/                      # Shared React components (from Consola)
│       ├── src/
│       │   ├── chat/            # AgentPanel, ChatMessage, ChatInput
│       │   ├── tools/           # ToolBlock, ToolCluster, ToolOutput
│       │   ├── markdown/        # MarkdownRenderer, CodeBlock
│       │   ├── diff/            # DiffView, file diff components
│       │   └── code/            # CodeSelection, SelectableCode
│       └── package.json
│
├── apps/
│   ├── backend/                 # The backend service
│   │   ├── src/
│   │   │   ├── server.ts        # Express/Fastify/Hono entry point
│   │   │   ├── api/
│   │   │   │   ├── agents.routes.ts
│   │   │   │   ├── repos.routes.ts
│   │   │   │   ├── schedules.routes.ts
│   │   │   │   ├── integrations.routes.ts
│   │   │   │   └── files.routes.ts
│   │   │   ├── websocket/
│   │   │   │   ├── AgentStreamGateway.ts
│   │   │   │   └── EventBroadcaster.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts
│   │   │   │   └── audit.ts
│   │   │   └── config/
│   │   │       └── index.ts     # Environment-based configuration
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── web/                     # React web frontend
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   ├── Dashboard.tsx        # Fleet overview
│   │   │   │   ├── RepoView.tsx         # Single repo + agent
│   │   │   │   ├── FleetView.tsx        # Multi-repo operations
│   │   │   │   ├── SchedulerView.tsx    # Schedule management
│   │   │   │   └── IntegrationsView.tsx # Integration config
│   │   │   ├── stores/                  # Zustand (patterns from Consola)
│   │   │   ├── services/               # HTTP/WebSocket clients
│   │   │   │   ├── agentClient.ts      # Replaces agentBridge
│   │   │   │   ├── repoClient.ts       # Replaces fileBridge + gitBridge
│   │   │   │   └── wsClient.ts         # WebSocket connection manager
│   │   │   └── components/             # Page-specific components
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   ├── cli/                     # Command-line interface
│   │   ├── src/
│   │   │   ├── index.ts         # CLI entry point
│   │   │   ├── commands/
│   │   │   │   ├── start.ts     # Start backend daemon
│   │   │   │   ├── repo.ts      # Manage repos
│   │   │   │   ├── agent.ts     # Run/manage agents
│   │   │   │   └── schedule.ts  # Manage schedules
│   │   │   └── config.ts        # CLI configuration
│   │   └── package.json
│   │
│   └── desktop/                 # Electron desktop app (optional, future)
│       ├── src/
│       │   ├── main/            # Thin Electron shell
│       │   │   ├── index.ts     # App lifecycle
│       │   │   └── BackendBridge.ts  # Connects to backend service
│       │   └── preload/
│       └── package.json
│
├── docker-compose.yml           # Local development stack
├── pnpm-workspace.yaml
├── turbo.json                   # Turborepo build orchestration
└── package.json
```

### Technology Choices

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Monorepo** | pnpm workspaces + Turborepo | Fast, proven, good for large TypeScript monorepos |
| **Backend Runtime** | Node.js 22+ (ESM native) | Eliminates ESM/CJS interop issues, Claude SDK is ESM |
| **Backend Framework** | Hono or Fastify | Lightweight, TypeScript-first, fast |
| **WebSocket** | ws (or Socket.io) | Real-time agent streaming |
| **Database** | PostgreSQL (prod) / SQLite (local) | PostgreSQL for team use, SQLite for single-user local |
| **ORM** | Drizzle ORM | Type-safe, lightweight, supports both PG and SQLite |
| **Queue/Jobs** | BullMQ + Redis | Scheduling, recurrent tasks, job processing |
| **Frontend** | React 19 + Vite | Same as Consola, component reuse |
| **State** | Zustand | Same as Consola, proven patterns |
| **UI Library** | Radix UI + Tailwind | Consola uses Radix, add Tailwind for rapid styling |
| **CLI** | Commander.js | Standard Node.js CLI framework |
| **Auth** | API keys + JWT (optional) | Simple for local, scalable for team |

---

## Part 5: Implementation Phases

### Phase 0: Foundation (Weeks 1-2)
**Goal**: Monorepo setup, core abstractions, backend skeleton

1. Initialize monorepo with pnpm + Turborepo
2. Create `packages/core` with shared types
3. Extract `ClaudeAgentService` into `packages/agent-engine`
4. Extract git operations into `packages/repo-manager/GitService`
5. Create `apps/backend` with basic Hono/Fastify server
6. Implement WebSocket streaming for single-agent queries
7. Create minimal web frontend that can chat with an agent

**Milestone**: Single-agent chat working via web browser → backend → Claude SDK

### Phase 1: Multi-Repo Fleet (Weeks 3-4)
**Goal**: Repository registration, sync, and fleet awareness

1. Build `RepoRegistry` — register repos with paths/URLs
2. Build `RepoSyncService` — clone, pull, track repos
3. Build fleet dashboard UI (repo list, status, metadata)
4. Implement workspace-scoped agent sessions (agent knows which repo)
5. Build file browsing API (replaces Electron file bridge)
6. Build git status/diff API (replaces Electron git bridge)

**Milestone**: Dashboard showing all repos, can run agent against any repo

### Phase 2: Agent Orchestration (Weeks 5-7)
**Goal**: Multi-agent teams and fleet-wide operations

1. Build `AgentPool` — manage concurrent agent instances
2. Build `AgentOrchestrator` — coordinate multi-agent workflows
3. Implement agent-to-agent communication (shared context, handoffs)
4. Build `FleetAgent` — operations spanning multiple repos
5. Implement fleet-wide change proposals (run same prompt across repos)
6. Build permission/approval workflows for fleet operations

**Milestone**: Can run "update all repos to use X" across 10+ repos with review

### Phase 3: Scheduling & Automation (Weeks 8-9)
**Goal**: Time-based recurrent agents

1. Implement `SchedulerService` with cron-like scheduling
2. Build `RecurrentTaskRunner` — execute scheduled agent tasks
3. Build `TriggerEngine` — event-driven triggers (webhook, git push, etc.)
4. Create scheduling UI (create/edit/monitor schedules)
5. Implement schedule templates (daily review, weekly cleanup, etc.)
6. Add audit logging for all automated actions

**Milestone**: Scheduled agent runs daily code review across fleet

### Phase 4: Integrations (Weeks 10-12)
**Goal**: Connect to external systems

1. Build `IntegrationHub` plugin architecture
2. Implement GitHub connector (PR creation, issue tracking, webhook receiver)
3. Implement Slack connector (notifications, chat interface)
4. Implement CI/CD connector (trigger builds, read results)
5. Implement observability connector (alert ingestion, metric queries)
6. Build integration configuration UI

**Milestone**: Agent creates PR, notifies Slack, triggers CI, reports back

### Phase 5: Production Readiness (Weeks 13-15)
**Goal**: Deployment, security, reliability

1. Docker containerization (single docker-compose up)
2. Authentication and authorization
3. Audit logging and compliance
4. Backup and disaster recovery
5. Health monitoring and alerting
6. Documentation and onboarding guide
7. CLI for daemon management (`platform start`, `platform status`)

**Milestone**: Production-ready self-hosted deployment

---

## Part 6: Deployment Architecture

### Local Development (Single Machine)

```
┌─────────────────────────────────┐
│         Your Laptop              │
│                                  │
│  ┌──────────┐  ┌──────────────┐ │
│  │ Web UI   │  │ Backend      │ │
│  │ :3000    │→ │ :8080        │ │
│  └──────────┘  │              │ │
│                │ SQLite       │ │
│  ┌──────────┐  │ BullMQ+Redis│ │
│  │ CLI      │→ │              │ │
│  └──────────┘  └──────────────┘ │
│                                  │
│  ~/repos/  (local git repos)    │
└─────────────────────────────────┘
```

### On-Premise Deployment (Team)

```
┌────────────────────────────────────────────────┐
│              On-Premise Server                   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Docker Compose / Kubernetes              │   │
│  │                                           │   │
│  │  ┌─────────┐  ┌──────────┐  ┌────────┐  │   │
│  │  │ Backend │  │PostgreSQL│  │ Redis  │  │   │
│  │  │ :8080   │  │ :5432    │  │ :6379  │  │   │
│  │  └─────────┘  └──────────┘  └────────┘  │   │
│  │  ┌─────────┐  ┌──────────┐              │   │
│  │  │ Web UI  │  │ Worker   │              │   │
│  │  │ :3000   │  │ (sched)  │              │   │
│  │  └─────────┘  └─���────────┘              │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  /repos/  (NFS mount or local clone)            │
└────────────────────────────────────────────────┘
         ↑
    Team accesses via internal network / VPN
```

---

## Part 7: What to Do with Consola

### Option A: Archive and Reference (Recommended)

Keep Consola as a reference project. Copy specific files into the new monorepo:
- `ClaudeAgentService.ts` → `packages/agent-engine/`
- Git operations from `ipc-handlers.ts` → `packages/repo-manager/GitService.ts`
- React chat components → `packages/ui/chat/`
- Type definitions → `packages/core/types/`
- Agent store patterns → reference for new stores

### Option B: Consola Becomes a Client

Long-term, Consola's Electron shell could become a desktop client for the platform:
- Replace direct Claude SDK calls with backend API calls
- Keep the rich desktop experience (terminal, file explorer)
- Add fleet/scheduling features to the desktop UI
- Best of both worlds: desktop UX + platform capabilities

### Option C: Consola Lives On as Standalone

Keep Consola for personal single-repo use. Build the platform separately for team/fleet use. They share `packages/agent-engine` and `packages/ui`.

---

## Part 8: Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Scope creep (too many features at once) | High | High | Strict phase gating, MVP per phase |
| Claude SDK limitations for multi-agent | Medium | High | Build abstraction layer, test early |
| Complex scheduling reliability | Medium | Medium | Use proven BullMQ, extensive testing |
| Integration maintenance burden | High | Medium | Plugin architecture, community connectors |
| Security of self-hosted deployment | Medium | High | Security audit, principle of least privilege |
| Performance with large fleets (100+ repos) | Medium | Medium | Lazy loading, pagination, background processing |

---

## Part 9: Key Decisions Needed

1. **Database choice**: PostgreSQL-only or dual-mode (SQLite for local, PG for team)?
2. **Authentication**: API keys only, or full OAuth/SAML for enterprise?
3. **Agent SDK**: Claude-only, or abstract for multi-provider (OpenAI, etc.)?
4. **Communication protocol**: REST + WebSocket, or gRPC for service-to-service?
5. **Plugin system**: In-process plugins, or separate process/container per integration?
6. **Repo access**: Git clone to local disk, or git-over-API (GitHub/GitLab API)?

---

## Code References

### Files to Extract from Consola

- `src/main/ClaudeAgentService.ts` — Core agent wrapper (zero Electron deps)
- `src/main/SessionStorageService.ts` — Session persistence facade
- `src/main/database/SessionDatabase.ts` — SQLite data layer (change constructor)
- `src/main/SessionNameGenerator.ts` — AI session naming
- `src/main/TerminalService.ts` — PTY management (zero Electron deps)
- `src/shared/types.ts` — Agent event types, query options
- `src/shared/constants.ts` — Event channel definitions (rename for platform)
- `src/renderer/components/Agent/` — Chat UI components (26 files)
- `src/renderer/components/Markdown/` — Markdown rendering (6 files)
- `src/renderer/stores/agentStore.ts` — Agent state patterns (24KB)

### Files That Cannot Be Reused

- `src/main/index.ts` — Electron-specific app lifecycle
- `src/main/window-manager.ts` — BrowserWindow management
- `src/main/ipc-handlers.ts` — Electron IPC routing (extract business logic only)
- `src/preload/preload.ts` — Electron context bridge
- All bridge services in `src/renderer/services/` — Replace with HTTP/WS clients

---

## Conclusion

**Create a new monorepo project.** The vision you're describing — fleet-wide agent orchestration, multi-repo management, scheduling, integrations — is fundamentally a different product than a desktop AI chat app. While ~30% of Consola's code can be extracted and reused (agent engine, UI components, patterns), the other 70% needs to be built from scratch.

The OpenClaw-inspired approach (self-hosted, local-first, user-controlled) naturally aligns with a backend service that runs as a daemon on your machine or a container on your server. Start with Phase 0 (extract agent engine, build minimal backend + web frontend) and iterate.

**Estimated total effort**: 15-20 weeks for a single developer, or 8-10 weeks for a small team (2-3 developers) working in parallel on backend/frontend/integrations.
