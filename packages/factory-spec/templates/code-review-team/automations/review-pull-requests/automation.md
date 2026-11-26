---
agent: orchestrator
triggers:
  - provider: github
    event: pull_request_opened
  - provider: github
    event: pull_request_ready
  - provider: github
    event: pull_request_reopened
---
A pull request needs a review. It was opened by a person, outside the factory, so there is no implementation agent to send findings back to.

If the pull request is a draft, stop silently: post nothing and complete the task.

Otherwise enter your procedure at the review step: dispatch the review agent with a brief that carries the pull request's link and what the event says. When its report comes back, post one review on the pull request yourself, as a comment review (never an approval or a request for changes), that follows the `code-review` skill's "Shape of a posted review" and carries every finding the report holds, unambiguous and ambiguous alike, since a person will address them. If the report has no findings, post a short review that says so. Then finish: say in your final message what you posted, with the pull request's link, and complete the task.
