---
name: code-review
description: The blocking rules, the severities, how to write a finding, the report a review agent returns, and the shape of a review the orchestrator posts.
---
# Code review

The review agent reads everything here but "Shape of a posted review", which belongs to the
orchestrator. The standard a change is judged against is the `code-quality` skill.

## What always blocks

A finding of any of these is `blocking`, whoever wrote the change and however small it is:

- **A correctness bug**: the change does the wrong thing on a path that can happen.
- **Data loss or a data leak**: data deleted, overwritten or corrupted; data shown, logged or
  sent to someone who should not have it.
- **A security hole**: injection, a missing authorization check, a secret in the change, input
  from outside trusted without checking, a permission wider than needed.
- **A broken contract**: a signature, an API, a file or wire format, a schema or an event payload
  changed without every caller and every stored record moved with it.
- **Missing tests for changed behaviour**: behaviour changed or added with no test that would
  fail if it broke.
- **Material drift from the spec**: required behaviour missing, a decision contradicted,
  significant scope the spec does not mention, or validation the spec requires left out.
- **Missing or mismatched visual proof** for a user-facing change: none, or a capture that shows
  the wrong path, an incomplete state, or leaves out an acceptance criterion.

## Severities

- `blocking`: the change must not merge until this is corrected. Every rule above, and anything
  else that makes the change wrong or unsafe.
- `important`: the change works, but this will cost someone soon: a missed edge case unlikely
  today, error handling that hides a cause, a misleading name, a test that does not test what it
  says, a convention of the repository broken. Fix it in this change unless there is a reason.
- `minor`: worth doing, fine to leave: a clearer name, a simpler expression, a comment that would
  help. Never more than a few; never one a linter or formatter would catch.

## How to write a finding

Each finding has four parts:

- **Location**: `path:line` in the change (the line on the pull request's head). A finding that
  spans a range gives its first line; one about the whole change says so.
- **Problem**: what is wrong, in one or two sentences, with the evidence: the input that breaks
  it, the caller it breaks, the line of the spec it contradicts.
- **Impact**: what happens to a user, to data or to the next developer if it ships.
- **Correction**: what to change, concretely. Name the function, the check, the test to add.

And:

- One real problem beats ten nits. Spend the reader's attention on what matters.
- No style nits a linter or formatter catches. If the repository has no linter, still skip them.
- Say how sure you are when you are not certain: "I could not confirm that `retry` is only
  called once; if it can be called twice, the lock leaks." A guess stated as a fact is worse
  than no finding.
- Verify before you report: read the code the finding is about, not only the diff. Run the
  test or the command when you can.
- Do not report what the change did not touch, unless the change makes it worse.

## The report a review agent returns

The review agent's final message is this report, and nothing else:

```
Verdict: accepted | revision needed | human decision needed

Summary: <one or two sentences on what the change does and how it holds up>

Findings:
1. [blocking | important | minor] [unambiguous | ambiguous] path:line
   Problem: ...
   Impact: ...
   Correction: ...

Not checked: <what you could not verify, and why; "nothing" when you checked it all>
```

- `accepted`: no findings. `revision needed`: only unambiguous findings. `human decision needed`:
  at least one ambiguous finding.
- `unambiguous`: it can be corrected without anyone's judgment. `ambiguous`: it needs a product
  or technical decision only a person can make; say what the decision is and the options.
- Write each ambiguous finding so it can be posted as it is, with no more context.

## Shape of a posted review

The orchestrator posts one review on the pull request, as a comment review (never an approval or
a request for changes), in this shape. Findings with a line in the diff are also inline comments
on that line, in the same review (the `github` skill has the call); findings without one are in
the body only.

```markdown
<One or two sentences: what the change does, in plain words.>

### Blocking
- **`path/to/file.ts:42`**: <problem>. <impact>. **Correction:** <correction>.

### Important
- **`path/to/other.ts:7`**: <problem>. <impact>. **Correction:** <correction>.

### Minor
- **`path/to/file.ts:88`**: <problem>. **Correction:** <correction>.

**Needs your decision:** <for each ambiguous finding, the decision and its options, in one line,
with its location>

**Not checked:** <what the review did not verify, in one line>

— Reviewed by the Consola factory
```

- Leave out a severity's heading when it has no findings, and the decision line when nothing
  is ambiguous.
- No findings at all: the summary, then "No findings.", the "Not checked" line and the
  attribution line.
- Each inline comment carries the finding's severity in bold first, then the problem, impact
  and correction, and no attribution line.
- Link every pull request and issue the review names.
