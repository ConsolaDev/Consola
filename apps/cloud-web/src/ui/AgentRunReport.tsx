import { ChevronRight, ExternalLink, GitCommitHorizontal, Workflow } from 'lucide-react';
import {
  agentRunPhase,
  agentRunSummary,
  dispatchedAgents,
  originFacts,
} from '../domain/cloudSession';
import type { AgentRun, OriginFacts } from '../domain/cloudSession';
import {
  AGENT_RUN_LABEL,
  DISPATCHED_STATUS_WORDS,
  dispatchedCount,
  NO_AGENT_REPORT,
  noAgentsWords,
  noSummaryWords,
} from '../domain/cloudSessionMessages';
import { hashOfFactoryPage } from '../domain/factoryNav';
import { ServiceMark } from './serviceMarks';

/**
 * What an agent run is, said above everything else on its page, by what started it
 * (`originFacts`): an automation's run says the automation in its factory (a link to the
 * factory's definition), its pull request (a link to GitHub, in a new tab) and the commit it
 * checks out; a request from Slack says how it came (a mention, a direct message) to its factory,
 * and its message (a link to Slack, in a new tab).
 */
export function AgentRunFacts({ run }: { run: AgentRun }) {
  const facts = originFacts(run.origin);
  return (
    <>
      <span className="agent-run-kind">
        <Workflow size={13} aria-hidden="true" />
        {AGENT_RUN_LABEL}
      </span>
      {facts.kind === 'slack' ? <SlackFacts facts={facts} /> : <AutomationFacts facts={facts} />}
    </>
  );
}

/** A request someone sent a factory's bot in Slack: how, to which factory, and the message. */
function SlackFacts({ facts }: { facts: Extract<OriginFacts, { kind: 'slack' }> }) {
  return (
    <>
      <span>
        {facts.via} to{' '}
        <a className="agent-run-link" href={hashOfFactoryPage(facts.factory.id)}>
          {facts.factory.name}
        </a>
      </span>
      {facts.url && <OpenInSlack url={facts.url} />}
    </>
  );
}

/** The Slack message a request came from, in a new tab. */
export function OpenInSlack({ url }: { url: string }) {
  return (
    <a
      className="agent-run-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title="The message in Slack"
    >
      <ServiceMark service="slack" size={12} />
      Open in Slack
      <ExternalLink size={12} aria-hidden="true" />
      <span className="sr-only"> (opens Slack in a new tab)</span>
    </a>
  );
}

/** An automation's run on a pull request: the automation, the pull request and its commit. */
function AutomationFacts({ facts }: { facts: Extract<OriginFacts, { kind: 'automation' }> }) {
  return (
    <>
      <span>
        <span className="agent-run-automation">{facts.automation}</span> in{' '}
        <a className="agent-run-link" href={hashOfFactoryPage(facts.factory.id)}>
          {facts.factory.name}
        </a>
      </span>
      {facts.url ? (
        <a
          className="agent-run-link"
          href={facts.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${facts.pullRequest} on GitHub`}
        >
          {facts.pullRequest}
          <ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only"> (opens GitHub in a new tab)</span>
        </a>
      ) : (
        <span>{facts.pullRequest}</span>
      )}
      <span className="agent-run-commit" title={`Commit ${facts.headSha}`}>
        <GitCommitHorizontal size={13} aria-hidden="true" />
        <span className="session-repository">{facts.shortSha}</span>
      </span>
    </>
  );
}

/**
 * What the runner last reported of an agent run: the first agent's (the foreman's) result, its
 * last message, kept as written with its line breaks (as text: a pull request's author can put
 * anything in it); then each agent it dispatched, a row of its name and status that opens on its
 * last report. The page reads the run again while it lives, so this follows it; once it has
 * ended, it stays, since it is on the run's row.
 */
export function AgentRunReport({ run }: { run: AgentRun }) {
  const phase = agentRunPhase(run);
  const summary = agentRunSummary(run);
  const agents = dispatchedAgents(run);
  const foreman = run.origin.agent;
  return (
    <section className="agent-run-report" aria-label="What the run reported">
      <h2 className="agent-run-heading">
        Result <span className="agent-run-heading-note">from {foreman}</span>
      </h2>
      {summary !== null ? (
        <div className="agent-run-summary">{summary}</div>
      ) : (
        <p className="agent-run-quiet">{noSummaryWords(phase, foreman)}</p>
      )}

      <h2 className="agent-run-heading">
        Agents it dispatched
        {agents.length > 0 && (
          <span className="agent-run-heading-note">{dispatchedCount(agents.length)}</span>
        )}
      </h2>
      {agents.length === 0 ? (
        <p className="agent-run-quiet">{noAgentsWords(phase, foreman)}</p>
      ) : (
        <ul className="agent-run-agents">
          {agents.map((agent) => (
            <li key={agent.id}>
              {/* Uncontrolled, so a fold the person opened stays open through the page's reads. */}
              <details className="agent-run-agent">
                <summary>
                  <ChevronRight className="agent-run-chevron" size={14} aria-hidden="true" />
                  <span
                    className="sessions-dot"
                    data-status={agent.status === 'working' ? 'running' : agent.status}
                    aria-hidden="true"
                  />
                  <span className="agent-run-agent-name">{agent.agent}</span>
                  <span className="agent-run-agent-status" data-status={agent.status}>
                    {DISPATCHED_STATUS_WORDS[agent.status]}
                  </span>
                </summary>
                <div className="agent-run-summary agent-run-agent-report">
                  {agent.summary?.trim() ? agent.summary : NO_AGENT_REPORT}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
