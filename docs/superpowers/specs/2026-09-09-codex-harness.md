# Codex harness

## Scope

Add an optional Codex driver to Settings → Harnesses. Configured instances use
the existing session picker, workspace defaults, archive lifecycle and profile
fields. Claude remains the built-in default. Consola embeds the Codex CLI's own
terminal UI and leaves authentication and approvals to Codex.

## Implementation

- `CodexDriver` resolves `codex` from the login PATH or a pinned executable,
  redirects profiles with `CODEX_HOME`, and probes version and login status.
  Login output is reduced to the authentication method; key fragments are never
  returned to the renderer.
- Codex assigns its own thread IDs. On first launch, a short-lived stdio
  app-server creates a thread, sets its name, resumes it to materialize the lazy
  transcript, then shuts down gracefully before the TUI attaches. No model turn
  runs during preparation. A `JsonStateFile` maps Consola's stable
  session ID to that native ID under `CODEX_HOME/consola/sessions/`.
- The interactive process uses `codex resume <native-id>`, including on its
  first attachment. Relaunches read the stored mapping; concurrent tabs get
  separate IDs. A failed resume leaves the error visible and retains the mapping.
- The TUI title is configured as `thread-id`. Each PTY observes its OSC 0/2
  title updates and atomically saves conversation switches to its own mapping,
  so an in-terminal `/new`, `/clear`, or `/resume` survives an app restart.
  Transcript text and resume hints are never used to choose a conversation.
  Shortened title IDs resolve only against unique native rollout filenames;
  unresolved prefixes are persisted and block resume rather than reverting to
  the previous conversation while a new rollout is still being materialized.
  This requires a Codex version supporting `tui.terminal_title` with `thread-id`
  (verified with 0.153.4). Older versions retain the launch-time mapping.
- Opening prompts use Codex's positional prompt argument. Later queued prompts
  can be delivered when an empty `›` composer is visible and no confirmation
  menu is present. Existing Claude prompt delivery remains supported.
- Conductor stdio MCP definitions become TOML `-c mcp_servers.<name>=...`
  overrides, with `required = true`. User profile files are not rewritten.
- CLI-owned model selection remains available through `/model` and launch args.
  Composer capability autocomplete and transcript-derived tab naming are not
  advertised for Codex in this version.

## Validation

Driver tests cover settings registration, environment isolation, health, native
ID persistence, parallel tabs, model/prompt arguments and conductor config.
Terminal tests cover asynchronous preparation, one-time opening prompts,
destruction during preparation, failed resumes and prompt delivery after trust.
The settings regression test covers probing a just-saved harness before its
state broadcast arrives. Preparation tests cover malformed responses, protocol
errors, early exits, timeouts and buffered transcript writes.
The offline Codex fixture implements the app-server handshake and an interactive
resume target for integration tests. A real installed CLI was also checked using
an isolated temporary profile: preparation followed by a fresh app-server process
successfully resumed the exact same thread without a model turn. The Electron
end-to-end test passes the real add/edit settings flow, prompt submission and
app restart with an offline CLI fixture.

## References

- [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
