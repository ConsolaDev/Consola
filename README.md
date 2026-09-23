<p align="center">
  <img src="apps/desktop/src/renderer/public/icon.svg" alt="Consola app icon" width="112" height="112">
</p>

<h1 align="center">Consola</h1>

<p align="center"><strong>Big ideas. One command center.</strong></p>

<p align="center">
  A home for your coding agents. Bring Claude Code, Codex, projects, and Git review together in one desktop app.
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#features">Features</a> ·
  <a href="#development">Development</a>
</p>

![Consola desktop app showing the workspace sidebar and a new conversation ready to start](docs/assets/consola-screenshot.png)

<p align="center"><sub>A new conversation in Consola, with agent selection and Git checkout controls.</sub></p>

## What is Consola?

Consola is an Electron desktop application for working with Claude Code and Codex. Organize projects into workspaces, keep resumable agent sessions together, and review code alongside your conversations. For structured development, Consola supports the **RPI methodology** (Research, Plan, Implement):

1. **Research** - Explore your codebase, understand existing patterns, and document findings
2. **Plan** - Create detailed implementation plans with clear success criteria
3. **Implement** - Execute plans with AI assistance, tracking progress against your plan

## Features

- **Multi-workspace Support** - Organize projects into workspaces for better context management
- **Tab-based Interface** - Work on multiple projects simultaneously
- **Claude Code Integration** - Runs the `claude` CLI itself, so every feature it ships is available as-is
- **Codex Harness** - Add OpenAI's Codex CLI in Settings → Harnesses and select it for new sessions
- **Session Terminals** - Open a normal shell alongside each agent, rooted in its checkout, with output and running commands preserved while switching sessions
- **Resumable Sessions** - Each tab keeps its conversation across restarts
- **Issue Tracker Integration** - Native sync with Linear and other project management tools
- **File Explorer & Git Review** - Browse files, review diffs, and stage and commit alongside the session
- **Dark/Light Themes** - Automatic system theme detection with manual override
- **Desktop Updates** - Signed macOS distributions download new releases and let you choose when to restart; check manually in Settings → Updates

## Getting Started

Published macOS installers are available from
[GitHub Releases](https://github.com/ConsolaDev/Consola/releases). Choose the
`arm64.dmg` download for Apple Silicon or `x64.dmg` for Intel, then drag Consola
into Applications. The steps below are for running from source.

### Prerequisites

- Node.js 22.12+
- pnpm 10.28.2 (`corepack enable` to enable the pinned package manager)
- Claude API access (via Claude Code CLI)

### Installation

```bash
# Clone the repository
git clone https://github.com/ConsolaDev/Consola.git
cd Consola

# Install dependencies
pnpm install

# Start development server
pnpm run dev
```

### Building for Production

```bash
# Build all components
pnpm run build

# Start the production app
pnpm start
```

For signed installers and publishing updates to installed apps, see the
[desktop release guide](docs/desktop-updates.md).

### Using Codex

Install and sign in to the Codex CLI, then open **Settings → Harnesses → Add
harness** and select **Codex**. Give it a name and leave the configuration fields
blank to use your normal installation and login. You can also set an explicit
binary path or a separate `CODEX_HOME` directory for another profile.

Select the harness when creating a session or set it as the workspace default.
Conversations resume across app restarts. Use Codex's `/model` menu or a harness
launch argument such as `--model <model>` to choose a model. Codex autocomplete
and automatic tab naming are not yet available in Consola's composer.

The integration requires a CLI supporting `app-server`, `thread/start`,
`thread/name/set`, and `thread/resume`. Update Codex if your CLI lacks these
methods. Consola keeps conversation ID mappings in `CODEX_HOME/consola/sessions`;
retain that folder alongside the profile's history when moving a profile.

### Running shell commands

Click the **Terminal** icon next to the file explorer button, or press **Ctrl+`**,
to open your normal interactive
shell in that session's directory (including its Git worktree). Drag the divider
to resize it; use the icon, shortcut, or **×** in the terminal header to hide it. Each session has its own shell,
and commands keep running while the panel is hidden or another session is active.
The panel shows the shell's starting directory; use `pwd` to see your current
location after `cd`.

The shell runs independently of the coding agent. After `exit`, click **New
shell** to start again. Deleting the session or its workspace, or quitting
Consola, stops its shell. Shell processes and output are not restored after an
app restart.

## Development

### Project Structure

```text
apps/
├── desktop/        # Electron app (package name: consola)
│   ├── src/
│   │   ├── main/     # Electron main process
│   │   ├── preload/  # Preload scripts for IPC
│   │   ├── renderer/ # React frontend
│   │   └── shared/   # App types and constants
│   ├── tests/      # Playwright tests and fixtures
│   ├── scripts/    # Development and packaging utilities
│   └── build/      # App icons
└── website/        # Static landing page (@consola/website)
    └── public/     # Authored HTML, CSS, JS, and assets
```

Implementation plans live in `docs/plans/`, and research and design mockups
live in `docs/research/`.

The root manages pnpm workspaces and Turborepo tasks. Future shared packages
can live in `packages/*`. Desktop outputs are in `apps/desktop/dist`, installers
in `apps/desktop/release`, and website build output in `apps/website/dist`.

Run commands below from the repository root. Use `pnpm --filter consola exec <command>`
for desktop tools, or `pnpm --filter @consola/website <script>` for the website.
Add dependencies to their owning workspace with
`pnpm --filter <package> add <dependency>`.

### Scripts

- `pnpm run dev` - Start development server with hot reload
- `pnpm run dev:website` - Preview the website at localhost:5174
- `pnpm run build` - Build both apps with Turborepo caching
- `pnpm test` - Run unit tests
- `pnpm run typecheck` - Check TypeScript
- `pnpm run build:main` - Build main process only
- `pnpm run build:renderer` - Build renderer only
- `pnpm run test:e2e` - Build the desktop app, then run Playwright E2E tests

## The RPI Methodology

The Research-Plan-Implement methodology brings engineering rigor to AI-assisted development:

### Research Phase
- Use `/research-codebase` to explore and document existing code
- Understand patterns, conventions, and architecture before making changes
- Generate research documents that persist as project knowledge

### Plan Phase
- Use `/create-plan` to design implementation strategies
- Break down work into trackable tasks with clear success criteria
- Review and iterate plans before writing code

### Implement Phase
- Use `/implement-plan` to execute plans with AI assistance
- Track progress against plan milestones
- Validate implementation against success criteria

## License

ISC
