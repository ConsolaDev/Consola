# Inbox navigation and shared context prototype

Open [providers.html](providers.html). This is the current prototype: it loads the production app’s theme tokens, layout, sidebar and Inbox styles. The workspace icon rail, Home/Inbox rail, workspace dropdown and main content frame follow the application. **Home** shows the existing scope/group/session sidebar; **Inbox** replaces that sidebar with navigation for work and integrations.

Use **Compare Inbox** in the title bar to switch three alternatives. The adjacent information button explains the tradeoffs. Switching alternatives preserves the current page, selected tracker, notes, links, sessions and added integrations in browser memory.

| Alternative | Inbox sidebar | Main tradeoff |
|---|---|---|
| A · Workflow first | Needs attention, tracked work, unlinked items, integrations, pinned trackers | Suggested starting point: shared work stays visible without hiding source views. |
| B · Integrations first | Cross-service attention, provider views nested under each integration, shared trackers | Familiar service-oriented navigation; connections and views lengthen the sidebar. |
| C · Tracker first | Attention, outcome trees with tickets/code/sessions, source access | Strong continuity within an outcome; larger work lists need folding and filtering. |

## Try the connected journey

1. Click **Home**, then **Inbox**. The middle sidebar changes; both rails remain.
2. Open **Make payment retries safe**. Its tracker combines Jira PAY-88, two GitHub PRs, a saved discussion reference and three sessions. Ticket status, code review state and local tracker state remain independent.
3. Add a handoff note. Switch the navigation alternative. The same tracker and note remain.
4. Resume **Address rounding feedback**. The session opens with the Home sidebar and a tracker context panel. **Open tracker** returns to the contextual Inbox navigation.
5. In **Links**, attach a URL or reject the ambiguous discussion suggestion. Reference URLs are validated; rejection persists until reload.
6. Open **GitHub** from the Inbox sidebar. The current review queue remains available, with the screenshot’s five visible PRs, five view tabs, seven sections, filters and detail/session pane. Select an untracked item and **Link to tracker**. You can attach it to an existing tracker or create one, retaining its linked sessions.
7. **Add integration → GitLab** creates a sample connection and source view. Link its merge request to the cache investigation tracker and start a sample session. The shared context also works for a different git provider.
8. Add a **Custom integration** with a name and category: code reviews, tickets, or documents/discussions. New sources appear in every navigation alternative. The sample catalog also includes Bitbucket, Azure DevOps, Asana, Slack and Notion.
9. Handle a Needs attention entry, then open Tracked work. Handling an update does not remove its tracker. Marking a tracker finished is local shelving and leaves provider states unchanged.

Jira and Linear retain assigned-issue, sprint/cycle and backlog views, with list/board layouts and Plan / Implement / Investigate actions. GitHub retains Review / Address review / Fix CI. Integrations are examples of source capabilities; the tracker joins artifacts by their role (defines, implements, discusses, evidence, reference), not by assuming every provider is a ticket system.

## Running

[Open the running preview](http://localhost:4176/providers.html). The current local preview server exposes the repository so production CSS resolves. Alternatively open the file directly, or serve the repository root:

```sh
python3 -m http.server 4177 --bind 127.0.0.1
```

Then open `http://localhost:4177/research/mockups/work-tracking/providers.html`. Serve from the repository root, not just the mockup directory, because the prototype uses the application’s real styles.

Direct comparison links: [workflow first](providers.html?nav=workflow), [integrations first](providers.html?nav=integrations), [tracker first](providers.html?nav=trackers). [GitHub’s existing queue](providers.html?provider=GitHub), [Jira](providers.html?provider=Jira), and [Linear](providers.html?provider=Linear) can also be opened directly.

## Scope and limits

Everything is sample data in browser memory. Reload resets it. Adding a connection never asks for credentials or contacts a service. Session actions create sample entries and a context preview; no agent or terminal runs. Provider writes, real sync, connection removal and authentication are outside this prototype. Workspace switching changes the sample frame identity; it does not load separate account data. Some artifact details are abbreviated. Static snapshot counts match the GitHub screenshot under default filters; hidden PR details were not invented, so expanding the team section explains the missing data. Changed filters count only known sample rows.

## Preview images

| Screen | Preview |
|---|---|
| A · Workflow sidebar and attention | [inbox-workflow.png](inbox-workflow.png) |
| B · Integration navigation | [inbox-integrations.png](inbox-integrations.png) |
| C · Tracker navigation | [inbox-trackers.png](inbox-trackers.png) |
| Cohesive tracker detail | [inbox-context.png](inbox-context.png) |
| Session with tracker context | [inbox-session-context.png](inbox-session-context.png) |
| GitHub in the current app frame | [provider-github.png](provider-github.png) |
| Jira in the current app frame | [provider-jira.png](provider-jira.png) |
| Linear in the current app frame | [provider-linear.png](provider-linear.png) |

## Verification

Checked with Playwright in installed Chrome: Home/Inbox sidebar switching; all three alternatives retaining edits; the existing GitHub queue; Jira/Linear source views; tracker creation and local completion; handoff notes; URL validation; reference removal and suggestion disposition; attention handling retaining work; session linking and context; adding GitLab and a custom integration; attaching their artifacts; responsive navigation at 820px and 390px; no script or asset errors. Visually inspected the workflow and tracker screenshots. These are prototype checks, not production integration tests or user validation.

## Earlier explorations

[Home navigation](home.html) preserves the earlier Home-only interaction sample and now opens this prototype from Inbox. [index.html](index.html) retains the earlier Work information-architecture exploration for reference; its separate shell is not the proposed application frame. [Read the evaluation](../../2026-09-10-work-tracking-information-architecture.md) for background and the updated design direction.
