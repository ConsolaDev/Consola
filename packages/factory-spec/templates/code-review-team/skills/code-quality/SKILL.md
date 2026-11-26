---
name: code-quality
description: The standard every change in this factory is held to, by the agent that writes it and by the agent that reviews it.
---
# Code quality

One standard, shared: the agent that writes a change reads it before writing, and the review
agent judges against it. Where the repository's own guidance says otherwise, the repository wins
(see "The repository's conventions").

## 1. Correct first

A change is first of all right. Everything below comes after it.

- It does what the request, the issue's acceptance criteria and the spec say, all of it, and
  nothing they do not ask for.
- Every path works: the empty case, the single item, the boundary, the failure, concurrent
  callers where there can be any, and input from someone who is not on your side.
- Behaviour it changes on purpose is listed in the pull request's description. Behaviour it
  changes by accident is a bug.
- A contract other code relies on (a function's signature or meaning, an API's shape, a file
  format, a database schema, an event's payload) changes only on purpose, with every caller
  moved with it, and old data still read.

## 2. Tests that would fail

A test earns its place by failing when the behaviour it covers breaks.

- Changed or new behaviour comes with a test that fails without the change. Run it without the
  change if you are unsure.
- Test what the code promises, through the interface its callers use, not its private steps.
- One behaviour per test, named for that behaviour: `refuses a label it cannot apply`, not
  `test2`.
- No test that passes whatever the code does: no assertion-free tests, no mocks that return the
  expected value back, no snapshot of a bug.
- A bug fix starts with a test that reproduces the bug.
- The whole suite passes before the change is handed over. A test skipped to get green is a
  finding, not a fix.

## 3. Errors are handled, never swallowed

- A failure is either handled (with a decision that is right for the caller) or passed on with
  what happened and where. A `catch` that logs and carries on as if nothing failed is a silent
  failure.
- No fallback that hides a problem: a default value in place of a failed read, an empty list in
  place of an error, a retry with no end.
- Messages say what failed, with the value that made it fail, and what the person can do.
- Clean up what was started (files, processes, connections, locks) on the failure path too.

## 4. Names and comments say what the code does

- A name says what the thing is or does, in the domain's words: `pendingReviews`, not `data2`.
  A boolean reads as a question: `isDraft`, `hasLabel`.
- A comment says why, or what a reader cannot see from the code: a constraint, a trap, the
  reason for an odd choice. It never restates the line below it.
- A comment that the change makes false is updated in the same change.
- No commented-out code, and no `TODO` without an issue it points at.

## 5. Small and focused

- One change does one thing. A refactor that the change needs comes first, on its own; one it
  does not need waits.
- No drive-by reformatting of lines the change does not touch: it hides the real diff.
- Prefer the existing helper, pattern or library over a new one. A new dependency needs a reason
  and a licence the repository accepts.
- No dead code: an unused function, branch, parameter, flag or import goes in the same change
  that made it unused.

## 6. Secrets and safety

- No secret, token, password, private key or customer data in code, tests, fixtures, logs or
  the pull request's text. A secret committed once is leaked, even after a revert.
- Input from outside (a request, a file, a webhook, a pull request's title) is checked before it
  is used, never put into a shell command, a query or HTML without escaping.
- Least privilege: a token, a permission or a scope is no wider than the change needs.

## 7. The repository's conventions

The repository says how it wants its code. Before writing or judging a change, read:

- the root `AGENTS.md` or `CLAUDE.md`, and any nearer one in the folders the change
  touches;
- the contributing guide, if there is one;
- the code beside the change: follow its patterns, its error handling, its test style.

Where they disagree with this skill, they win. Where they say nothing, this skill applies.

## Before handing over

- [ ] The change does what was asked, and only that.
- [ ] Tests cover the changed behaviour and fail without it; the suite passes.
- [ ] No silent failure, no secret, no dead code.
- [ ] Names and comments are true.
- [ ] The repository's own checks (lint, typecheck, build) pass.
