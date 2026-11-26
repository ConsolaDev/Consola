import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_FILES_MAX_BYTES,
  AGENT_RUN_PROMPT_MAX,
  AGENT_RUN_SUMMARY_MAX,
  readAgentRun,
  readAgentRunReport,
} from './agentRun.js';

/** What the other side really sends: the value after `JSON.stringify` and `JSON.parse`. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const review = {
  name: 'review',
  description: 'Reviews a pull request.',
  instructions: 'You review pull requests for Sprocket.',
  model: 'claude-sonnet-5',
};
const run = {
  agent: 'orchestrator',
  prompt: 'Review pull request 7 of sprocket/catalog-portal.',
  model: 'claude-opus-5-5',
  checkout: { ref: 'refs/pull/7/head', sha: 'a'.repeat(40) },
  agents: [review, { name: 'tests', description: '', instructions: 'You run the tests.' }],
  files: [
    { path: 'factory.yml', content: 'version: 1\n' },
    { path: 'agents/review.md', content: '# Review\n' },
  ],
};
const report = {
  state: 'working',
  summary: 'Dispatched the review.',
  agents: [{ id: 'conversation-1', agent: 'review', status: 'done', summary: 'Looks good.' }],
};

describe('readAgentRun', () => {
  it('reads an agent run as it was sent', () => {
    expect(readAgentRun(wire(run))).toEqual({ ok: true, value: run });
  });

  it('reads one with only what it needs', () => {
    const bare = { agent: 'orchestrator', prompt: 'Go.', agents: [], files: [] };
    expect(readAgentRun(wire(bare))).toEqual({ ok: true, value: bare });
  });

  it('reads a branch ref and the caps themselves', () => {
    const value = {
      ...run,
      prompt: 'p'.repeat(AGENT_RUN_PROMPT_MAX),
      checkout: {
        ref: 'refs/heads/feature/cart.v2_x',
        sha: '0123456789abcdef0123456789abcdef01234567',
      },
      files: [{ path: 'big.md', content: 'x'.repeat(AGENT_RUN_FILES_MAX_BYTES) }],
    };
    expect(readAgentRun(wire(value)).ok).toBe(true);
  });

  const agents = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ ...review, name: `agent-${index}` }));
  const files = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ path: `f/${index}.md`, content: '' }));

  it.each([
    ['not an object', 'orchestrator'],
    ['an array', [run]],
    ['no agent', { ...run, agent: undefined }],
    ['no prompt', { ...run, prompt: undefined }],
    ['no agents', { ...run, agents: undefined }],
    ['no files', { ...run, files: undefined }],
    ['an unknown field', { ...run, token: 'x' }],
    ['an agent name with capitals', { ...run, agent: 'Orchestrator' }],
    ['an agent name starting with a dash', { ...run, agent: '-orchestrator' }],
    ['an agent name too long', { ...run, agent: `a${'b'.repeat(63)}` }],
    ['an empty prompt', { ...run, prompt: '' }],
    ['a prompt too long', { ...run, prompt: 'p'.repeat(AGENT_RUN_PROMPT_MAX + 1) }],
    ['a model with a space', { ...run, model: 'claude opus' }],
    ['a model starting with a dot', { ...run, model: '.claude' }],
    ['a model too long', { ...run, model: `m${'x'.repeat(128)}` }],
    ['a checkout without a sha', { ...run, checkout: { ref: 'refs/pull/7/head' } }],
    ['a checkout with an unknown field', { ...run, checkout: { ...run.checkout, x: 1 } }],
    [
      'a checkout ref that is a tag',
      { ...run, checkout: { ...run.checkout, ref: 'refs/tags/v1' } },
    ],
    ['a pull ref numbered 0', { ...run, checkout: { ...run.checkout, ref: 'refs/pull/0/head' } }],
    ['a pull ref of a merge', { ...run, checkout: { ...run.checkout, ref: 'refs/pull/7/merge' } }],
    ['a branch ref with ..', { ...run, checkout: { ...run.checkout, ref: 'refs/heads/a/../b' } }],
    ['a branch ref with a space', { ...run, checkout: { ...run.checkout, ref: 'refs/heads/a b' } }],
    ['a short sha', { ...run, checkout: { ...run.checkout, sha: 'a'.repeat(39) } }],
    ['an uppercase sha', { ...run, checkout: { ...run.checkout, sha: 'A'.repeat(40) } }],
    ['agents not a list', { ...run, agents: review }],
    ['more than 16 agents', { ...run, agents: agents(17) }],
    ['an agent named twice', { ...run, agents: [review, review] }],
    ['an agent with a bad name', { ...run, agents: [{ ...review, name: 'Review' }] }],
    ['an agent with an unknown field', { ...run, agents: [{ ...review, tools: [] }] }],
    ['an agent without a description', { ...run, agents: [{ ...review, description: undefined }] }],
    [
      'an agent description too long',
      { ...run, agents: [{ ...review, description: 'd'.repeat(1001) }] },
    ],
    ['an agent with empty instructions', { ...run, agents: [{ ...review, instructions: '' }] }],
    [
      'agent instructions too long',
      { ...run, agents: [{ ...review, instructions: 'i'.repeat(AGENT_RUN_PROMPT_MAX + 1) }] },
    ],
    ['an agent with a bad model', { ...run, agents: [{ ...review, model: 'a b' }] }],
    ['files not a list', { ...run, files: 'factory.yml' }],
    ['more than 128 files', { ...run, files: files(129) }],
    ['a file named twice', { ...run, files: [run.files[0], run.files[0]] }],
    ['a file with an unknown field', { ...run, files: [{ path: 'a', content: '', mode: 7 }] }],
    ['a file without content', { ...run, files: [{ path: 'a' }] }],
    ['an absolute path', { ...run, files: [{ path: '/etc/passwd', content: '' }] }],
    ['a path climbing out', { ...run, files: [{ path: 'agents/../../x', content: '' }] }],
    ['a path with a . segment', { ...run, files: [{ path: './factory.yml', content: '' }] }],
    ['a path with an empty segment', { ...run, files: [{ path: 'agents//x', content: '' }] }],
    ['a path ending in /', { ...run, files: [{ path: 'agents/', content: '' }] }],
    ['an empty path', { ...run, files: [{ path: '', content: '' }] }],
    ['a path with a backslash', { ...run, files: [{ path: String.raw`agents\x`, content: '' }] }],
    ['a path with a control character', { ...run, files: [{ path: 'a\nb', content: '' }] }],
    ['a path too long', { ...run, files: [{ path: 'p'.repeat(301), content: '' }] }],
    [
      'files too large together',
      {
        ...run,
        files: [
          { path: 'a', content: 'x'.repeat(AGENT_RUN_FILES_MAX_BYTES) },
          { path: 'b', content: 'x' },
        ],
      },
    ],
  ])('refuses %s', (_name, value) => {
    expect(readAgentRun(wire(value)).ok).toBe(false);
  });

  it('names the field in a reason and never what it held', () => {
    const read = readAgentRun(
      wire({ ...run, files: [{ path: '/hunter2-secret', content: 'hunter2-content' }] }),
    );
    expect(read).toEqual({ ok: false, reason: expect.stringContaining('path') });
    expect(JSON.stringify(read)).not.toContain('hunter2');
    const prompt = readAgentRun(wire({ ...run, agent: 'Hunter2' }));
    expect(prompt).toEqual({ ok: false, reason: expect.stringContaining('agent') });
    expect(JSON.stringify(prompt)).not.toContain('Hunter2');
  });
});

describe('readAgentRunReport', () => {
  it('reads a report as it was sent', () => {
    expect(readAgentRunReport(wire(report))).toEqual({ ok: true, value: report });
  });

  it('reads a bare state, and each state', () => {
    for (const state of ['working', 'waiting', 'done', 'failed']) {
      expect(readAgentRunReport(wire({ state }))).toEqual({ ok: true, value: { state } });
    }
  });

  it('reads an empty summary and a dispatched agent without one', () => {
    const value = {
      state: 'done',
      summary: '',
      agents: [{ id: 'c', agent: 'r', status: 'failed' }],
    };
    expect(readAgentRunReport(wire(value))).toEqual({ ok: true, value });
  });

  const dispatched = report.agents[0];
  const many = Array.from({ length: 33 }, (_, index) => ({ ...dispatched, id: `c-${index}` }));

  it.each([
    ['not an object', 'working'],
    ['no state', { summary: 'x' }],
    ['an unknown state', { state: 'paused' }],
    ['an unknown field', { ...report, cost: 3 }],
    ['a summary too long', { ...report, summary: 's'.repeat(AGENT_RUN_SUMMARY_MAX + 1) }],
    ['a numeric summary', { ...report, summary: 3 }],
    ['agents not a list', { ...report, agents: dispatched }],
    ['more than 32 agents', { ...report, agents: many }],
    ['an agent without an id', { ...report, agents: [{ ...dispatched, id: undefined }] }],
    ['an agent with an empty id', { ...report, agents: [{ ...dispatched, id: '' }] }],
    ['an agent with a bad name', { ...report, agents: [{ ...dispatched, agent: 'Review' }] }],
    [
      'an agent with an unknown status',
      { ...report, agents: [{ ...dispatched, status: 'waiting' }] },
    ],
    ['an agent with an unknown field', { ...report, agents: [{ ...dispatched, cost: 1 }] }],
    [
      'an agent summary too long',
      { ...report, agents: [{ ...dispatched, summary: 's'.repeat(AGENT_RUN_SUMMARY_MAX + 1) }] },
    ],
  ])('refuses %s', (_name, value) => {
    expect(readAgentRunReport(wire(value)).ok).toBe(false);
  });
});
