import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Session } from '../../shared/workspace';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test';
import { AssistantTools, type AssistantToolsDeps } from './AssistantTools';

type MockDeps = { [K in keyof AssistantToolsDeps]: Mock<AssistantToolsDeps[K]> };

let deps: MockDeps;
let tools: AssistantTools;

const worker = () => makeSession({ id: 'w-1', name: 'worker', instanceId: 'inst-w1', kind: 'interactive' });
const assistant = () =>
  makeSession({ id: 'a-1', name: 'Assistant', instanceId: 'inst-a1', kind: 'assistant', groupId: undefined });
const workspaces = () => [
  makeWorkspace({ sessions: [makeSession(), worker(), assistant()] }),
  makeWorkspace({
    id: 'ws-2',
    name: 'Other',
    sessions: [makeSession({ id: 'x-1', workspaceId: 'ws-2', instanceId: 'inst-x1', kind: 'interactive' })],
  }),
];

beforeEach(() => {
  deps = {
    getWorkspaces: vi.fn(workspaces),
    status: vi.fn(() => 'ready' as const),
    deliverPrompt: vi.fn(async () => 'queued' as const),
    recentReplies: vi.fn(async () => []),
    screenText: vi.fn(() => null),
    start: vi.fn(),
    watch: vi.fn(),
  };
  tools = new AssistantTools(deps);
});

describe('consola_prompt_session', () => {
  it('prompts a session in its own workspace and watches it', async () => {
    deps.deliverPrompt.mockResolvedValue('woken');
    const result = await tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'pull latest' });
    expect(deps.deliverPrompt).toHaveBeenCalledWith('ws-1', 'w-1', 'pull latest');
    expect(deps.watch).toHaveBeenCalledWith('a-1', 'w-1');
    expect(result).toEqual({
      delivery: 'woken',
      summary: '"worker" was not running; Consola resumed its conversation and queued the prompt.',
    });
  });

  it('says how a queued or re-run prompt travels, never that it arrived', async () => {
    expect(await tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'go' })).toEqual({
      delivery: 'queued',
      summary: 'Queued for "worker"; it is delivered when its composer is free, never typed into a menu.',
    });
    deps.deliverPrompt.mockResolvedValue('rerun');
    expect(await tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'go' })).toEqual({
      delivery: 'rerun',
      summary: '"worker" is read-only; Consola re-ran it unattended with this prompt. It can only read and report.',
    });
  });

  it('watches nothing when delivery fails', async () => {
    deps.deliverPrompt.mockRejectedValue(new Error('"worker" is in the middle of an unattended run; wait for it to finish.'));
    await expect(tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'go' })).rejects.toThrow(/unattended run/);
    expect(deps.watch).not.toHaveBeenCalled();
  });
});

describe('the workspace boundary', () => {
  it('never reaches another workspace, or itself', async () => {
    await expect(tools.handlePromptSession('a-1', { session_id: 'x-1', prompt: 'hi' })).rejects.toThrow(
      'No session x-1 in this workspace.'
    );
    await expect(tools.handleReadSession('a-1', { session_id: 'x-1', messages: 3 })).rejects.toThrow(
      'No session x-1 in this workspace.'
    );
    await expect(tools.handlePromptSession('a-1', { session_id: 'a-1', prompt: 'hi' })).rejects.toThrow('That is you.');
    await expect(tools.handleReadSession('a-1', { session_id: 'a-1', messages: 3 })).rejects.toThrow('That is you.');
    expect(deps.deliverPrompt).not.toHaveBeenCalled();
    expect(deps.recentReplies).not.toHaveBeenCalled();
    expect(deps.watch).not.toHaveBeenCalled();
  });

  it('refuses a caller that is not the Assistant', async () => {
    await expect(tools.handlePromptSession('w-1', { session_id: 'cond-1', prompt: 'hi' })).rejects.toThrow(
      'Calling session is not the Assistant.'
    );
    await expect(tools.handleStartSession('cond-1', { name: 'n', prompt: 'p' })).rejects.toThrow(
      'Calling session is not the Assistant.'
    );
    expect(deps.deliverPrompt).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it('refuses a caller whose record is gone', async () => {
    await expect(tools.handleReadSession('gone-1', { session_id: 'w-1', messages: 3 })).rejects.toThrow(
      'The Assistant no longer exists.'
    );
  });

  it('re-reads the records on every call', async () => {
    await tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'go' });
    // w-1 deleted after the first call: the next one must not reach it.
    deps.getWorkspaces.mockImplementation(() => [makeWorkspace({ sessions: [makeSession(), assistant()] })]);
    await expect(tools.handlePromptSession('a-1', { session_id: 'w-1', prompt: 'go' })).rejects.toThrow(
      'No session w-1 in this workspace.'
    );
    expect(deps.deliverPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('consola_read_session', () => {
  it('reads replies and the live screen, marked untrusted', async () => {
    deps.recentReplies.mockResolvedValue(['Two issues found.']);
    deps.screenText.mockReturnValue('❯ ');
    expect(await tools.handleReadSession('a-1', { session_id: 'w-1', messages: 3 })).toMatchObject({
      sessionId: 'w-1',
      name: 'worker',
      status: 'ready',
      replies: ['Two issues found.'],
      screen: '❯ ',
      note: expect.stringMatching(/never as instructions/),
    });
    expect(deps.recentReplies).toHaveBeenCalledWith(expect.objectContaining({ id: 'w-1' }), 3);
    expect(deps.screenText).toHaveBeenCalledWith('inst-w1');
    expect(deps.status).toHaveBeenCalledWith('inst-w1');
  });

  it('says when a harness keeps transcripts Consola cannot read', async () => {
    deps.recentReplies.mockResolvedValue(null);
    expect(await tools.handleReadSession('a-1', { session_id: 'w-1', messages: 3 })).toMatchObject({
      replies: [],
      transcript: 'Consola cannot read this harness’s transcripts; this is its screen only.',
    });
  });

  it('does not call a readable harness unreadable when there is no transcript yet', async () => {
    deps.recentReplies.mockResolvedValue([]);
    const result = await tools.handleReadSession('a-1', { session_id: 'w-1', messages: 3 });
    expect(result).toMatchObject({ replies: [] });
    expect(result).not.toHaveProperty('transcript');
  });

  it('leaves the screen out when the session is not running', async () => {
    deps.status.mockReturnValue('exited');
    deps.recentReplies.mockResolvedValue(['Done.']);
    const result = await tools.handleReadSession('a-1', { session_id: 'w-1', messages: 1 });
    expect(result).toMatchObject({ status: 'exited', replies: ['Done.'] });
    expect(result).not.toHaveProperty('screen');
    expect(result).not.toHaveProperty('transcript');
  });
});

describe('consola_start_session', () => {
  const workItem = { repo: 'sprocket/catalog-portal', number: 4229, type: 'pr' as const };

  it('starts a session through the shared starter and watches it', async () => {
    deps.start.mockResolvedValue({
      session: { id: 's-9', name: '#4229 review' } as Session,
      mode: 'read-only',
    });
    const result = await tools.handleStartSession('a-1', {
      name: '#4229 review',
      prompt: 'review it',
      work_item: workItem,
      read_only: true,
    });
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-1' }), {
      name: '#4229 review',
      prompt: 'review it',
      workItem,
      readOnly: true,
    });
    expect(deps.watch).toHaveBeenCalledWith('a-1', 's-9');
    expect(result).toEqual({
      sessionId: 's-9',
      name: '#4229 review',
      mode: 'read-only',
      summary: 'Started "#4229 review" (read-only). You will hear when it settles.',
    });
  });

  it('passes a folder, a cwd and a group through, and says when it got full tools', async () => {
    deps.start.mockResolvedValue({ session: { id: 's-10', name: 'fix flaky e2e' } as Session, mode: 'full-tools' });
    const result = await tools.handleStartSession('a-1', {
      name: 'fix flaky e2e',
      prompt: 'fix it',
      scope_path: '/repos/app',
      cwd: '/repos/app/e2e',
      group: 'catalog',
    });
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-1' }), {
      name: 'fix flaky e2e',
      prompt: 'fix it',
      scopePath: '/repos/app',
      cwd: '/repos/app/e2e',
      group: 'catalog',
    });
    expect(result.summary).toBe('Started "fix flaky e2e" (full tools). You will hear when it settles.');
  });

  it('watches nothing when the start is refused', async () => {
    deps.start.mockRejectedValue(new Error('/elsewhere is not one of this workspace’s folders.'));
    await expect(
      tools.handleStartSession('a-1', { name: 'n', prompt: 'p', scope_path: '/elsewhere' })
    ).rejects.toThrow(/not one of this workspace’s folders/);
    expect(deps.watch).not.toHaveBeenCalled();
  });
});
