# Consola

Your command center for AI-assisted development. Built on top of Claude Code, Consola brings structure to AI coding through the **RPI methodology** (Research, Plan, Implement) with native integration to your issue trackers for seamless project management.

## What is Consola?

Consola is an Electron desktop application that enhances Claude Code with a structured development workflow. Instead of ad-hoc AI conversations, Consola guides you through three phases:

1. **Research** - Explore your codebase, understand existing patterns, and document findings
2. **Plan** - Create detailed implementation plans with clear success criteria
3. **Implement** - Execute plans with AI assistance, tracking progress against your plan

## Features

- **Multi-workspace Support** - Organize projects into workspaces for better context management
- **Tab-based Interface** - Work on multiple projects simultaneously
- **Claude Code Integration** - Powered by the Claude Agent SDK for intelligent code assistance
- **Issue Tracker Integration** - Native sync with Linear and other project management tools
- **Rich Output Rendering** - Markdown, code blocks, and diff views in agent responses
- **Streaming Responses** - Real-time output from AI agents
- **Dark/Light Themes** - Automatic system theme detection with manual override

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn
- Claude API access (via Claude Code CLI)

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/consola.git
cd consola

# Install dependencies
npm install

# Start development server
npm run dev
```

### Building for Production

```bash
# Build all components
npm run build

# Start the production app
npm start
```

## Development

### Project Structure

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts for IPC
├── renderer/       # React frontend
│   ├── components/ # UI components
│   ├── hooks/      # Custom React hooks
│   ├── stores/     # Zustand state management
│   └── services/   # API and bridge services
└── shared/         # Shared types and constants
```

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run build:main` - Build main process only
- `npm run build:renderer` - Build renderer only
- `npm run test:e2e` - Run Playwright E2E tests

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
