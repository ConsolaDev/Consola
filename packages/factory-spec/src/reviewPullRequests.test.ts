import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseFactory, storedFactoryFiles } from './factory';
import { isStepsEntry } from './schema';
import type { AgentStep, CommandStep } from './steps';

/*
 * The Review pull requests files: the canonical copies of `automations/review-pr.yaml` and
 * `agents/reviewer.md` that a person pastes into a factory, and that the cell's demo factory
 * carries (`apps/cloud-region`'s `DEMO_FACTORY_FILES`, held equal to these by its own test).
 * Read here as the cell reads a stored set, so a file this folder holds is checked as a save is.
 */

const FOLDER = join(__dirname, 'fixtures', 'review-pull-requests');

/** Every file under `folder`, by its path inside it, with `/` between parts. */
function filesIn(folder: string, prefix = ''): Array<{ path: string; content: string }> {
  return readdirSync(join(folder, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? filesIn(folder, path)
      : [{ path, content: readFileSync(join(folder, path), 'utf8') }];
  });
}

const files = filesIn(FOLDER);
const read = parseFactory(storedFactoryFiles(files));

function reviewPr() {
  const automation = read.automations.find((candidate) => candidate.name === 'review-pr');
  if (!automation || !isStepsEntry(automation)) throw new Error(JSON.stringify(read.issues));
  const [review, post] = automation.steps;
  return { automation, review: review as AgentStep, post: post as CommandStep };
}

describe('the Review pull requests files', () => {
  it('are a factory.yml, the automation and its agent', () => {
    expect(files.map((file) => file.path).sort()).toEqual([
      'agents/reviewer.md',
      'automations/review-pr.yaml',
      'factory.yml',
    ]);
  });

  it('parse with no issue and no notice', () => {
    expect(read.issues).toEqual([]);
    expect(read.notices).toEqual([]);
    expect(read.automations.map((automation) => automation.name)).toEqual(['review-pr']);
    expect(Object.keys(read.agents)).toEqual(['reviewer']);
  });

  it('fire when a pull request opens, gets new commits or reopens, and run on their own once approved', () => {
    const { automation } = reviewPr();
    expect(automation.trigger).toEqual({
      kind: 'event',
      connection: 'github',
      events: ['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'],
      params: {},
    });
    expect(automation.mode).toBe('auto');
    expect(automation.steps.map((step) => [step.id, step.kind])).toEqual([
      ['review', 'agent'],
      ['post', 'run'],
    ]);
  });

  it('review as a read-only agent that names no harness, with a typed verdict and the review as its handover', () => {
    const { review } = reviewPr();
    expect(review).toMatchObject({
      kind: 'agent',
      agent: 'reviewer',
      outputs: { verdict: { type: 'enum', values: ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] } },
      // The post step reads it, so the review must write it.
      handover: 'required',
    });
    const reviewer = read.agents.reviewer;
    expect(reviewer.tools).toBe('read-only');
    expect(reviewer).not.toHaveProperty('harness');
    expect(reviewer).not.toHaveProperty('model');
    expect(reviewer.mcpServers).toEqual([]);
    expect(reviewer.skills).toEqual([]);
  });

  it('post with gh, every value through env:, with only pull_requests: write', () => {
    const { post } = reviewPr();
    expect(post.permissions).toEqual({ pull_requests: 'write' });
    expect(post.env).toEqual({
      REPO: '{{item.repo}}',
      NUMBER: '{{item.number}}',
      VERDICT: '{{steps.review.verdict}}',
      BODY_FILE: '{{steps.review.handover.file}}',
    });
    expect(post.run).toContain('gh api "repos/$REPO/pulls/$NUMBER/reviews"');
    expect(post.run).toContain('commit_id="$CONSOLA_CHECKOUT_HEAD"');
  });
});

describe("the Review pull requests post step's command", () => {
  const scratch = mkdtempSync(join(tmpdir(), 'review-pr-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  // A `gh` that prints its arguments, one a line, in place of GitHub's.
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const body = join(scratch, 'review.md');
  writeFileSync(body, 'Looks right.\n');

  /** What the command hands gh for a verdict, run as a runner runs it, with env: rendered. */
  const posted = (verdict: string) =>
    execFileSync('/bin/sh', ['-c', reviewPr().post.run], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        REPO: 'sprocket/catalog-portal',
        NUMBER: '51',
        VERDICT: verdict,
        BODY_FILE: body,
        CONSOLA_CHECKOUT_HEAD: 'a1b2c3d',
      },
      encoding: 'utf8',
    })
      .trimEnd()
      .split('\n');

  it('posts the review on the commit the run read', () => {
    expect(posted('REQUEST_CHANGES')).toEqual([
      'api',
      'repos/sprocket/catalog-portal/pulls/51/reviews',
      '-f',
      'commit_id=a1b2c3d',
      '-f',
      'event=REQUEST_CHANGES',
      '-F',
      `body=@${body}`,
    ]);
  });

  it('never approves unattended: APPROVE is posted as COMMENT (decision 35)', () => {
    expect(posted('APPROVE')).toContain('event=COMMENT');
    expect(posted('COMMENT')).toContain('event=COMMENT');
    expect(posted('APPROVE')).not.toContain('event=APPROVE');
  });
});
