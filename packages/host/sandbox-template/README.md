# The `consola-session` sandbox template

The sandbox a Consola cloud session runs in. A runner (`consola-host runner`,
`packages/host/AGENTS.md`, "The `runner` command") makes one per session, from
this template, on Consola's own E2B account, and runs its start script there.
People never see E2B.

The template and the host's bundle in it are Consola's alone: the bundle holds
the Claude Agent SDK, so neither is ever published, shared or released (root
`AGENTS.md`, "Licensing"; Linear CON-21).

## What it holds

| Program | Version | From |
| --- | --- | --- |
| Node | 26.13.1 | nodejs.org's `linux-x64` build, checked against its SHA-256 |
| git | the base image's distribution's | `apt` |
| GitHub's CLI (`gh`) | 2.105.0 | its `linux_amd64` release, checked against its SHA-256 |
| Claude Code (`claude`) | 2.1.330 | npm, `@anthropic-ai/claude-code` |
| Codex (`codex`) | 0.171.0 | npm, `@openai/codex` |
| `@ff-labs/fff-node`, with `@ff-labs/fff-bin-linux-x64-gnu` | 0.11.0 | npm, in `/opt/consola/node_modules`, with t3's patch |
| `ffi-rs`, with `@yuuang/ffi-rs-linux-x64-gnu` | 1.3.2 | npm, in `/opt/consola/node_modules` |

- **The host**, `/opt/consola/consola-host.mjs`, and t3's Claude history
  worker beside it, `/opt/consola/claude-history-worker.mjs`, which t3's Claude
  adapter runs as a process of its own to read a conversation it resumes. Both
  are ESM files from `pnpm --filter @consola/host bundle` (`scripts/bundle.ts`),
  each holding all it runs but Node's own modules and two packages t3 requires
  at run time from beside it: `@ff-labs/fff-node` (t3's workspace file search,
  which the host loads as it starts) and `ffi-rs` (its native bridge). Both
  are installed here, at the versions the workspace runs the bundle with, and
  fff-node gets the patch pnpm gives it in the workspace
  (`patches/@ff-labs__fff-node@0.11.0.patch`: its async search methods, and its
  CommonJS entry pointed at them), applied with `git apply`.
- **The start script**, `consola-session-start` (on the `PATH`), which the
  runner runs (below).
- **`/workspace`**, the session's folder, owned by `user`, the user E2B runs
  commands as.

Every program is in `/usr/local/bin`, which the template's `PATH` names first:
E2B runs commands with no login shell, so a profile's `PATH` is never read.
`DISABLE_AUTOUPDATER=1` keeps Claude Code at its version. The base image
(`e2bdev/base:latest`) is E2B's, and git is whatever its distribution's `apt`
has as the template is built: the build's log prints every version (its last
`RUN`).

It writes no t3 settings (`settings.json` in the host's state folder): a
provider's launch arguments there would override the host's approval mode
(`AGENTS.md`, "The host never starts a CLI in full access"). The host keeps its
state in a temporary folder of its own.

## The start script

`consola-session-start` reads the variables the runner gives a sandbox
(`sandboxEnvFor`) and:

1. clones `https://github.com/$CONSOLA_REPOSITORY.git` into `/workspace/repo`.
   git asks a credential helper for github.com, which answers with `$GIT_TOKEN`
   as the environment holds it; the token is never in the URL (where it would
   reach the process list, `.git/config` and git's error text), on a command
   line or in a file. The repository keeps that helper (no other is asked), and
   `user.name` `Consola session`, `user.email` `session@consola.invalid`.
2. On a failed clone, prints one line on stdout, `{"type":"exit","reason":"clone-failed","message":"…"}`,
   git's words with the token (as it is and URL-encoded) taken out, and exits
   1. The runner says the session `failed` with that message.
3. Writes `$CONSOLA_PASS_PUBLIC_KEY` to `/workspace/.consola/pass-public-key.pem`.
4. For a Codex session, signs Codex in: `codex login --with-api-key`, the key
   from `$OPENAI_API_KEY` on stdin. Codex reads no API key from its
   environment (its documentation: "Pipe the key to `codex login` through
   stdin"); Claude Code reads `ANTHROPIC_API_KEY` from its own. A failed sign-in
   says so on stderr and exits 1.
5. Becomes the host: `exec node /opt/consola/consola-host.mjs session
   --session-id … --harness … --cwd /workspace/repo --bind 0.0.0.0 --port 7420
   --pass-public-key /workspace/.consola/pass-public-key.pem --idle-minutes
   ${CONSOLA_SESSION_IDLE_MINUTES:-10}`. Its first stdout line is `ready`
   (stderr carries the folder warning first).

Stdout is the runner's: the script prints nothing else there. Its tests are
`src/bundle.test.ts`.

## Building it

On Consola's E2B account, under the name the runner creates sandboxes from
(`SESSION_TEMPLATE`, `consola-session`). Building again replaces it. From the
repository root:

```bash
pnpm exec turbo run build --filter=@consola/host^...   # the host's dependencies
pnpm --filter @consola/host template:build
```

`template:build` bundles the host, stages this folder in
`packages/host/dist/sandbox-template/` with the two bundled files and the
fff-node patch, and builds it with `@consola/sandbox/e2b`'s builder
(`scripts/build-template.ts`). The key is
`E2B_API_KEY`, from the environment, or else from `packages/sandbox/.env`; it is
never an argument and never printed. The build prints the template's id.

**Template id:** not built yet. Record the id the build prints here, and only
the id.

## The sandbox's lifetime

The runner leases each sandbox for ten minutes at a time and renews the lease
every three while it holds the session (`keepAlive`), never past the session's
lifetime cap (`--max-session-minutes`), so a runner that dies leaves no sandbox
running for more than ten minutes, and E2B stops one at the cap even should the
runner's own stop fail. E2B's plan also bounds how long a sandbox may run; a
session cannot outlast it, whatever the cap says.
