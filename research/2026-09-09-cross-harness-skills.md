# Reusable skills across Consola harnesses

Date: 2026-09-09. Status: research and proposed design, not an implemented feature.

## Recommendation

Build a Skills library that owns package acquisition, versions, installation targets, and compatibility reporting. Let each harness discover and execute the installed package through its native skill system. Keep one managed source for each revision and expose it to selected destinations through small driver adapters.

The product promise should be: **install once, choose where it is available, see whether it will work there**. Availability means native discovery and invocation, not identical model behavior. Sharing files is relatively straightforward; controlling effective visibility and preserving harness-specific semantics are the harder parts.

User clarification: the primary selection unit is an existing **harness configuration**, such as `claude-personal` versus `claude-work`, not merely the Claude versus Codex product. A skill enabled for Claude Personal must not become available to Claude Work as a consequence of that installation. Cross-product reuse remains useful, but configuration-specific availability is a first-release requirement.

Start with Claude Code and Codex, the two drivers implemented in this checkout. Design adapters for OpenCode, Gemini CLI, Copilot CLI, and Cursor as subsequent targets. Installing for an external application does not require Consola to have a session driver for it.

## Evidence and confidence

This study combines current primary documentation, the checked-out application, the installed binaries, and a temporary Codex discovery experiment. Web pages are living documentation, not specifications pinned to a released binary. Paths below are defaults unless stated otherwise.

Local versions: `codex-cli 0.153.4` and `Claude Code 2.1.267`, obtained with `--version`. No model turns were run. No actual user skill installation or profile configuration was changed. Temporary fixtures and schema exports were written outside the repository.

The Codex experiment used a separate temporary `CODEX_HOME` and Git repository. It confirmed:

- `skills/list` reports a skill under that profile's `skills/` directory with user scope.
- A repository `.agents/skills/<name>` symlink to a complete skill directory is discovered with repo scope.
- `skills/extraRoots/set` accepts an additional root; a subsequent list reports its skills.
- `skills/config/write` disables a fixture by its `SKILL.md` path; the next list reports `enabled: false`.

The generated schema, with and without experimental fields, exposes `cwds` and `forceReload` for `skills/list`, but not the documentation's `perCwdExtraUserRoots`. The alternative process-level extra-roots method worked. An initial probe timed out while reading responses; repeating with a dedicated JSON-line reader resolved that probe issue. This was discovery/configuration verification, not an end-to-end TUI invocation test.

## Current ecosystem

The common package is a directory containing YAML-frontmatter `SKILL.md`, optionally with scripts, references, assets, and other files. Required standard metadata includes `name` and `description`; optional fields include `license`, `compatibility`, `metadata`, and experimental `allowed-tools`. The package format does not establish one universal installer or permission model. [Agent Skills specification](https://agentskills.io/specification)

| Harness | Default project locations | Default personal locations | Invocation and management |
|---|---|---|---|
| Claude Code | `.claude/skills/`; also legacy `.claude/commands/` | `~/.claude/skills/` | `/name`, automatic selection; plugin skills use namespaces. [Documentation](https://code.claude.com/docs/en/skills) |
| Codex | `.agents/skills/` along the CWD-to-repository-root ancestry | `~/.agents/skills/`; profile-local `skills/` also verified in the installed build | `$name`; local configuration can disable by path. Symlink discovery is documented. [Documentation](https://learn.chatgpt.com/docs/build-skills) |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | Native `skill` tool; skill permissions support allow/ask/deny. [Documentation](https://opencode.ai/docs/skills/) |
| Gemini CLI | `.gemini/skills/`, `.agents/skills/` | `~/.gemini/skills/`, `~/.agents/skills/` | `activate_skill`; `/skills` lists, enables, disables, links, and reloads. `gemini skills install` accepts repositories/local directories. [Documentation](https://geminicli.com/docs/cli/skills/) |
| Copilot CLI | `.github/skills/`, `.agents/skills/`, `.claude/skills/`; parent discovery also documented | `~/.copilot/skills/`, `~/.agents/skills/` | `/name`, automatic selection; custom roots via `COPILOT_SKILLS_DIRS`; `/skills add`. [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) |
| Cursor | `.agents/skills/`, `.cursor/skills/`; Claude/Codex compatibility directories | `~/.agents/skills/`, `~/.cursor/skills/`; Claude/Codex compatibility directories | Automatic discovery, skill commands, UI management. Personal local files do not automatically reach remote/cloud sessions. [Documentation](https://prod.cursor.com/docs/skills) |

Do not assume the directory list establishes profile isolation, identical support in every client surface, or an installed minimum version. Claude's reviewed discovery table does not advertise `.agents/skills/` as a direct root. For the first implementation, use its documented native location and verify custom-profile behavior.

Additional differences:

- Claude extends skills with argument substitution, dynamic shell injection, hooks, invocation controls, and forked subagent execution. Its current `skillOverrides` setting controls standalone skill visibility; plugin skills are excluded from that setting. [Claude skills](https://code.claude.com/docs/en/skills)
- Codex supports optional `agents/openai.yaml` metadata and implicit-invocation policy. Duplicate names are not merged and can both appear. Its documentation advises restarting after configuration changes. [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- OpenCode ignores unknown frontmatter fields. Its compatibility directories mean a Claude-targeted installation can also become visible to OpenCode. [OpenCode skills](https://opencode.ai/docs/skills/)
- Gemini uses workspace-over-user precedence, with `.agents/skills` winning over `.gemini/skills` within a tier. Native activation includes consent and access to the skill directory. [Gemini skills](https://geminicli.com/docs/cli/skills/)

These differences require driver-specific resolution. A single generic “project overrides personal” rule would be incorrect.

## What Consola already provides

| Existing code | Implication for this feature |
|---|---|
| `src/shared/harness.ts` | A harness is a configured instance: stable ID, driver, optional binary/config directory, extra args, enabled/archive state. Target instances, not only product names. |
| `src/main/drivers/HarnessDriver.ts` | Existing boundary for binary, environment, launch args, and optional inspection. Add optional skill support through this boundary or an associated adapter. |
| `src/main/drivers/ClaudeDriver.ts` | Honors `CLAUDE_CONFIG_DIR`; capability probing runs from home, not the session CWD. |
| `src/main/drivers/CodexDriver.ts` | Honors `CODEX_HOME`; currently omits `probeCapabilities`. It already uses app-server for initial thread preparation, then launches a separate interactive `codex resume` process. |
| `src/main/drivers/codexAppServer.ts` | A bounded helper for preparing threads, not a persistent session connection. Reuse protocol infrastructure carefully; a second app-server cannot control the TUI's in-memory state. |
| `src/main/drivers/claudeCapabilities.ts` | Maps CLI commands, agents, models, and account metadata. The handshake can run SessionStart hooks. It is not a complete package inventory. |
| `src/main/HarnessCapabilitiesCache.ts` | Process-lifetime cache keyed by launch configuration, without CWD. Skills need a different cache lifecycle. |
| `src/shared/types.ts` | No dedicated skill package, installation, compatibility, or effective-availability types. |
| `src/renderer/components/PromptComposer/` | Commands insert `/name`; agent mentions insert `@name`. The trigger list currently lacks `$`. |
| `src/main/state/HarnessService.ts` | Main-process single-writer persistence pattern suitable for a skill registry. |
| `src/main/SessionLauncher.ts` | Session CWD can differ from the workspace through scopes and worktrees. Skill discovery must use the actual launch CWD. |

The February skills/settings plan describes an earlier Agent SDK architecture. It is historical context, not the implementation seam to revive. The August Consola plugin design separates host UI extensions from harness capabilities; this feature should remain a harness-management service, consistent with that separation. The factories direction also makes repo-portable packages preferable to machine-specific absolute paths for future remote runs.

## The selection problem: placement is not visibility

The user's concrete setup includes Claude, Claude Personal (`claude-personal`), Claude Work (`claude-work`), and Codex. The screenshot configures Claude Work with `~/.claude-work`; the personal configuration's path is not shown and must be resolved from its saved record rather than guessed.

The intended installation is:

| Configured instance | Example selection | Proposed result |
|---|---|---|
| Claude Personal | Selected | Materialize the package in this configuration's verified native skill root. |
| Claude Work | Not selected | Do not expose the package through this configuration or a shared root it reads. |
| Codex | Optional | Add its own binding to the same managed package when selected. |

Bind these choices to stable `Harness.id` values. Use `driverId` to choose the adapter, never as the enablement key. With separate, verified profile roots, configuration-specific placement is the preferred mechanism; per-skill exclusion rules are only needed when discovery overlaps. An inherited copy must be surfaced as a conflict with a personal-only request, not accepted silently as successful isolation.

There are three separate decisions:

1. Which package revision exists in the library?
2. Which destinations does Consola manage for it?
3. Which harnesses actually discover and can invoke it?

For example, placing a package in `~/.agents/skills` makes it discoverable by multiple products. Putting it in `.claude/skills` can reach compatibility scanners too. Two named Consola harnesses can share a config directory. Choosing only one row in the UI cannot undo those facts.

Represent discovery roots as a small graph: each root has readers, scope, precedence, and ownership; each installation has desired targets and observed consumers. Canonicalize destination paths so two aliases of one directory do not produce duplicate writes.

Use these explicit states in the UI:

- **Available:** enabled and confirmed by native discovery, where enumeration exists.
- **Installed:** files are placed, but runtime availability is unverified.
- **Inherited:** visible through a shared or externally managed root.
- **Disabled:** native policy blocks activation.
- **Needs attention:** conflict, missing dependency, unsupported behavior, or drift.
- **Restart required:** the running process has not adopted a change.

An unchecked target means “Consola will not install here.” It should mean “unavailable here” only when a verified native exclusion achieves that. A harness that shares the same root must show the shared scope or use a tested launch-scoped policy. Do not silently relocate profiles or copy credentials to manufacture isolation.

Offer two deliberate distribution modes:

| Mode | Placement | Honest behavior |
|---|---|---|
| Selected destinations, default | Private managed source plus native per-target directories or supported extra roots | Keeps source storage out of ambient discovery. Preview any additional readers of each destination. |
| Shared with compatible tools | Shared `.agents/skills` location plus required native adapters | Deliberately opts into broader discovery, including tools outside Consola. |

If strict selection cannot be achieved, show that before installation and offer a supported scope. Never temporarily swap one shared directory as users switch tabs: concurrent sessions would race and see each other's selections. Native skill visibility is also not a filesystem access-control boundary.

## Proposed storage and adapters

An illustrative personal layout:

```text
~/.consola/skills/
  registry.json
  packages/<package-id>/<revision>/<skill-name>/
    SKILL.md
    scripts/
    references/
    assets/
  projections/<target-id>/<skill-name>/
```

The exact application-data location should follow Consola's persistence convention. This proposal's important property is that unselected package sources are outside auto-discovered directories.

Use stable native destinations pointing to the selected package revision. Prefer per-skill directory links where tested; use tracked copies when links are unsupported or inaccessible to a sandbox. Never link an entire existing skills directory. Preserve the complete directory, executable bits, relative resources, and required package files. Skills referring to files outside their own directory require explicit dependency handling.

Project sharing needs a portable path: vendor the package into the repository or commit a manifest/lockfile with a materialization workflow. Relative links between committed project directories can work on tested platforms. An absolute symlink to a developer's home directory must not be the only committed artifact. Repository writes and changes to Git tracking should be visible in the install preview.

Separate core records:

```typescript
interface SkillPackage {
  id: string;                    // provenance identity, not the invocation name
  name: string;
  description: string;
  source: { kind: 'git' | 'local' | 'archive'; locator: string; subpath?: string };
  revision: string;              // Git commit or local/archive content digest
  digest: string;
  managedPath: string;
}

interface SkillBinding {
  id: string;
  packageId: string;
  revision: string;
  targetId: string;              // harness instance or external installation target
  scope: 'personal' | 'project';
  projectRoot?: string;
  desiredEnabled: boolean;
}

interface SkillObservation {
  bindingId?: string;            // absent for unmanaged existing skills
  nativeName: string;
  nativePath: string;
  effectiveEnabled?: boolean;   // unknown is different from false
  evidence: 'native-list' | 'filesystem';
  diagnostics: string[];
}
```

Add a deployment ledger recording destination, source digest, file/link ownership, consumer targets, and last applied revision. Store compatibility assessments separately by package digest, driver version, and environment. A skill name is not a sufficient identity: different repositories can publish the same name.

Keep responsibilities small:

- `SkillSourceService`: resolve local/repository/archive inputs into staged, versioned packages.
- `SkillCatalogService`: inventory managed and external packages, parse metadata, assess portability.
- `SkillInstallService`: produce a preview, apply installations, journal results, update/remove/repair owned materializations.
- `HarnessSkillAdapter`: discover roots, query effective skills, resolve naming/precedence, plan native placement and enablement, format invocation, report refresh support.

The adapter should return declarative file/config/launch operations for the installer to apply under one writer. Native configuration operations can be specialized executors where needed. Avoid making ordinary reads or capability probes mutate profiles.

Suggested methods are `inspect(context)`, `planBinding(package, target)`, `formatInvocation(skill, args)`, and `refreshSupport(context)`. The context includes driver version, resolved binary, resolved environment/profile, actual CWD/worktree, and relevant launch options. Optional support must distinguish unsupported enumeration from an empty skill list.

For Codex, official app-server methods include `skills/list`, `skills/config/write`, `skills/changed`, and process-level extra roots. It also supports explicit skill input items for app-server turns. Consola's current PTY transport should insert `$name`; listing through a sidecar is useful, but its extra roots or reload state do not automatically carry into the separately launched TUI. [App-server reference](https://learn.chatgpt.com/docs/app-server)

Therefore, begin with verified native disk placement for actual sessions. Gate extra-root launch integration on a separate TUI discovery/resume test. Avoid switching the conversation transport merely to obtain a skill picker.

## Compatibility, not automatic translation

Classify each package separately for each target:

| Assessment | Example | Proposed handling |
|---|---|---|
| Compatible by inspection | Standard instructions plus relative references | Install unchanged; label runtime verification separately. |
| Requires environment setup | Python script or an MCP tool dependency | Show the missing runtime/tool for that target; installing instructions does not install the dependency. |
| Requires adaptation | Tool names, absolute paths, argument placeholders, subagent behavior | Explain the unsupported dependency; offer an explicit target variant. |
| Unsupported | Required feature cannot be represented in that harness | Do not claim the workflow is ready there. |

Preserve unknown metadata instead of stripping it. Scan body text as well as frontmatter: a valid package can still depend on Claude-only tool names, a specific MCP server, browser integration, a plugin root variable, or another skill. Static detection is advisory; it cannot prove an arbitrary workflow behaves correctly.

Do not silently drop manual-only invocation policy or reinterpret tool permissions. A field being accepted or ignored does not establish equivalent enforcement. If a conversion is useful, keep its output as an explicit reviewed variant derived from the original digest. Upstream updates must re-evaluate that variant.

Treat plugin-sourced skills as externally owned initially. A full Claude plugin, Codex plugin, Gemini extension, and Consola UI plugin have different packaging and lifecycle requirements. Extracting one skill does not reproduce its hooks, MCP servers, sibling resources, or namespace. Offer standalone adoption only when those dependencies are understood.

## User experience

Add **Settings → Skills**, with an optional per-harness Skills view and a project filter. Show existing skills before asking users to install anything. Each row includes name, origin, revision, scope, compatible targets, and effective availability.

Example installation:

1. Paste a repository URL or select a local folder.
2. Consola discovers packages and lets the user choose one or several.
3. Select configured instances such as “Claude Personal,” “Claude Work,” and “Codex,” then choose “All projects for selected configurations” or “This project.” Avoid labeling installation scope merely “Personal,” which could be confused with the user's named Personal configuration.
4. Show the resolved revision, compatibility issues, collisions, and any additional tools that will inherit visibility.
5. Install once. Show a per-target result and an action to use the skill.

Keep “all configured harnesses” as an explicit convenience selection. Offer a separate preference for automatically enabling newly added harnesses; adding a harness should not silently enroll it in every past installation. External installation targets can appear separately from launchable harnesses.

Also expose a Skills list on each configuration's detail view. A user should be able to open Claude Personal, select an existing library skill, and enable it there without editing Claude Work. Switching between simultaneous Personal and Work sessions must preserve their distinct availability. Test this exact scenario with separate temporary profiles, including a negative assertion that Work does not discover the Personal-only fixture.

For existing skills, default to **Link to another harness** or **Import a managed copy**, with clear ownership. Updating an imported copy should not modify the original repository. Detect existing symlink setups and avoid adopting them merely because they were scanned.

The composer should offer a common skill picker, then insert the target's native invocation into the draft. Add `$` for Codex; preserve native names and plugin namespaces. Selecting a row must not submit the prompt. Keep generic commands and skills distinct internally even when they share a menu. For future harnesses without verified direct syntax, use a supported native path or label a plain-language request accurately.

Refresh the inventory after install, enable/disable, external file changes, harness config edits, and CWD changes. Key its cache by resolved environment, binary/version, actual CWD, and a catalog/config generation. Keep the existing general capability cache separate. Show restart requirements without restarting an active terminal automatically; removing a skill cannot erase instructions already loaded into a conversation.

## Installation lifecycle

Use an inspect → plan → apply → verify sequence. Staging should not execute package scripts or hooks. Resolve immutable revisions, validate package paths and links against extraction boundaries, and never interpolate source URLs into shell text. Use the existing Git/SSH credential machinery for private repositories without copying credentials into skill records.

Before any write, inspect every destination for collisions and existing ownership. Revalidate immediately before applying: another window or external installer may have changed the files. Journal each applied operation and report partial results. Filesystems across profiles cannot provide a single atomic multi-directory transaction; atomic per-destination replacement plus compensating rollback is the practical approach.

Update only owned destinations that still match the previous recorded state. Preserve user-modified files and report drift. Uninstall removes only links/copies/config entries owned by that binding; retain shared materializations until their last binding is removed. Roll back configuration by restoring only the fields Consola changed, without overwriting unrelated edits.

For updates, stage a new revision and rerun compatibility checks before switching bindings. Retain old revisions while they may be needed for rollback or by active sessions. Scope the MVP to restart-required adoption if runtime snapshot behavior is uncertain. Explicit local-development links can follow working-tree edits; immutable installed packages should not pretend to be live development sources.

For archived harnesses, keep binding metadata. Deleting or archiving a harness must not remove shared skill files that another instance or resumable session still needs.

## Existing installer: reuse or build?

Vercel's `skills` CLI already offers multi-agent selection, local/Git sources, package listing, global/project scope, and symlink/copy installation. It is an immediately useful precedent and interoperability target. [Project documentation](https://github.com/vercel-labs/skills)

Its implementation uses a canonical shared directory for symlink installations and has special handling for agents reading that directory directly. This confirms that a selected agent list is not, by itself, proof of exclusive visibility. [Installer source](https://github.com/vercel-labs/skills/blob/main/src/installer.ts)

| Approach | Benefit | Limitation for Consola |
|---|---|---|
| Shell out to `skills` | Fast prototype; broad target support | Must reconcile its destination/ownership semantics with custom harness profiles and previewable transactions. |
| Reuse or vendor selected acquisition/parsing components | Saves source-resolution work | Requires a pinned contract, license review, and maintenance ownership. |
| Own a small native installer | Fits named profiles, one writer, drift handling, and explicit visibility | More implementation and adapter maintenance. |

Recommendation: own the registry, destination planning, and lifecycle. Evaluate pinned upstream components for acquisition; do not make an unpinned `npx ...@latest` process the product's installation authority. Import existing external installations and interoperate with standard packages without requiring users to migrate everything.

## Implementation sequence and acceptance criteria

### 1. Inventory and invocation

Add shared skill types, main-process catalog/adapters, IPC bridge, renderer store, and Skills UI. Implement Claude filesystem inventory with explicit uncertainty for runtime visibility; Codex uses native listing. Combine project inventory with existing command capabilities without assuming every slash command is a skill. Add Codex invocation completion.

Acceptance: different profiles and actual worktree CWDs show the correct skills; duplicate names remain distinguishable; unavailable enumeration is not presented as an empty list; selection inserts native text without submission. Reads do not launch Claude hooks merely to scan files.

### 2. Install once into Claude and Codex

Add local-folder and Git-source acquisition, a managed store, named-target bindings, installation preview, tracked links/copies, updates, removal, and repair. Support personal and repository-portable project placement. Make shared visibility explicit wherever roots overlap.

Acceptance: one source revision is usable in both harnesses; single-target placement does not claim stronger exclusion than verified; two targets sharing a destination produce one owned materialization; removing one binding preserves the other; modified external files survive updates/uninstall.

### 3. Native selection and lifecycle verification

Validate native enable/disable adapters, current-session refresh, custom profiles, and resume behavior across tested versions. Exercise Claude symlink discovery and command naming, Codex TUI discovery/resume, and sandbox access to external package resources. Support launch-scoped selection only where it is proven across both fresh and resumed sessions.

Acceptance: disabled states match native behavior; live sessions retain clear restart status; concurrent harnesses never require swapping shared files; filesystem and native-list observations reconcile after external edits.

### 4. More targets and distribution

Add OpenCode and Gemini adapters, then Copilot/Cursor installation targets as user demand warrants. Add catalog search, richer dependencies, explicit variants, and repo lockfile materialization. Expand to complete native plugin/extension management only as a distinct feature.

Meaningful tests include same-name packages, shared profiles, root-directory symlinks, broken links, nested repos/worktrees, missing scripts, incompatible invocation policies, drift, failed partial installs, rollback, and restart/resume. Native discovery fixtures should run without model calls; a small intentional invocation smoke suite is separate from routine filesystem tests.

## Decisions to settle during implementation

- Default scope: propose all projects for selected configurations, with project scope remembered per workflow. Internal `personal` scope means user-level placement, not the configuration named Personal.
- Default target policy: explicit currently selected instances, with separate opt-in for future harnesses.
- Strict selection: promise it only for supported native visibility policies; otherwise show inherited consumers.
- Local authoring: distinguish a live link from an immutable installed copy.
- First release: prioritize Claude/Codex named profiles and project portability over a large marketplace.

The main feasibility question is answered: a useful cross-harness library fits Consola's current seams. The remaining release gates are native visibility and invocation behavior for each supported binary version, especially shared roots, custom profiles, and active/resumed sessions.
