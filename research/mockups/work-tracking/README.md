# Work tracking design prototype

Start with [Home navigation](home.html) for the first implementation slice. It reuses the application's theme tokens, sidebar styles, and spacing. Switch scopes, fold groups, view all workspace sessions, and use a group’s **+** to open the composer with that scope and group. Sending creates a fictional session only; cancelling or changing context creates nothing. Agent/model controls are illustrative. The theme toggle previews the app’s light and dark palettes. **Inbox** links to the earlier work-tracking exploration.

The production app uses Home and its existing Inbox as the working rail destinations. Home filters groups and Ungrouped by scope; All your sessions spans the workspace and labels each session’s scope. The scope selector also sets the destination for the composer, keyboard shortcut, fan-out, and orchestration. Scope management remains in workspace settings. Activity, Artifacts, and Tickets are outside this first slice.

Open [index.html](index.html) in a browser. It is standalone, requires no server or install, and makes no service calls. The surrounding prototype controls are separate from the proposed app UI.

[Read the evaluation and staged plan](../../2026-09-10-work-tracking-information-architecture.md).

## Try the main journey

1. Open **Make payment retries safe** in Work, then **Open work**.
2. Inspect the outcome, remaining review work, latest decision, linked artifacts, and sessions.
3. **Resume review session** to see the terminal beside its work context.
4. Open **Inbox**, handle the payment update, and return to **Work**. The task remains.
5. In the Track's **Links** tab, reject the ambiguous Slack suggestion or add a URL reference.
6. Browse **Work → Sources → Jira** and track PAY-102. Or use **Track work** to create local work without a ticket.
7. Use **Compare navigation** to inspect the original Inbox model, one Work hub, and the work-centric sidebar.

Search, list filters, previews, tabs, handling/snoozing, manual linking, suggestion disposition, and local Track creation run in browser memory. Reload or Reset restores the sample. Start-session settings illustrate a context selection flow but always open the sample session; no agent executes. Handoff notes demonstrate entry in the session context panel and reset on navigation. Snooze does not run a real timer. Secondary Tracks have abbreviated details. Back navigation is simplified; preserving every list's scroll/filter state is a production requirement in the proposal. The prototype does not implement sync, remote source navigation, editing provider data, real terminal input, merging, or persistence.

## Static mockups

| Recommended flow | Preview |
|---|---|
| Work overview | [work.png](work.png) |
| Inbox attention queue | [inbox.png](inbox.png) |
| Work detail | [detail.png](detail.png) |
| Session with work context | [session.png](session.png) |
| Provider browsing | [sources.png](sources.png) |
| Compact Work layout | [work-compact.png](work-compact.png) |

| Alternative navigation | Preview |
|---|---|
| A. Everything in Inbox | [alternative-inbox.png](alternative-inbox.png) |
| B. One Work hub | [alternative-hub.png](alternative-hub.png) |
| D. Work in the sidebar | [alternative-tree.png](alternative-tree.png) |

## Verification

Checked with Playwright against installed Chrome: five primary screens, four navigation models, preview-to-detail navigation, ambiguous-relation rejection, manual URL attachment, handled Inbox signals retaining the Track in Work, and horizontal overflow at 820px and 390px. Inspected the Work and detail screenshots visually. These are prototype checks, not validation with users or production app tests.
