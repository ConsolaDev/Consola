import { describe, expect, it } from 'vitest';
import {
  agentStepFoot,
  agentStepHead,
  ITEM_TEXT_LINE,
  nodeGrantsLine,
  serverGrantLine,
  serversFact,
  skillsFact,
  skillsLine,
} from './agentGrantWords';

const CORALOGIX = { name: 'claude.ai Coralogix' };
const GRAFANA = { name: 'grafana', tools: ['query_logs'] };

describe('serverGrantLine', () => {
  it('says a whole server brings every tool it has, posting ones included', () => {
    expect(serverGrantLine({ name: 'claude.ai Slack' })).toBe(
      'claude.ai Slack: all its tools, including any that post or change things',
    );
  });

  it('names the tools the last probe listed, ten at most', () => {
    expect(
      serverGrantLine({ name: 'claude.ai Slack', knownTools: ['post_message', 'list_channels'] }),
    ).toBe(
      'claude.ai Slack: all its tools (post_message, list_channels), including any that post or change things',
    );
    const twelve = Array.from({ length: 12 }, (_, index) => `tool_${index + 1}`);
    expect(serverGrantLine({ name: 'tracker', knownTools: twelve })).toBe(
      'tracker: all its tools (tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7, tool_8, tool_9, tool_10 and 2 more), including any that post or change things',
    );
    // A probe that listed none says nothing of them.
    expect(serverGrantLine({ name: 'tracker', knownTools: [] })).toBe(
      'tracker: all its tools, including any that post or change things',
    );
  });

  it('names a narrowed server by the tools it is granted, whatever the probe listed', () => {
    expect(serverGrantLine({ ...GRAFANA, knownTools: ['query_logs', 'list_dashboards'] })).toBe(
      'grafana: query_logs only',
    );
    expect(
      serverGrantLine({ name: 'grafana', tools: ['query_logs', 'list_dashboards', 'get_panel'] }),
    ).toBe('grafana: query_logs, list_dashboards and get_panel only');
    expect(serverGrantLine({ name: 'grafana', tools: ['query_logs', 'get_panel'] })).toBe(
      'grafana: query_logs and get_panel only',
    );
  });
});

describe('the skills and facts', () => {
  it('says the skills by folder name, and nothing for none', () => {
    expect(skillsLine(['incident-triage', 'release-notes'])).toBe(
      'Skills: incident-triage, release-notes',
    );
    expect(skillsLine([])).toBeNull();
    expect(skillsFact(['incident-triage', 'release-notes'])).toBe('incident-triage, release-notes');
    expect(skillsFact([])).toBeNull();
  });

  it("gives the step detail's servers with each narrowing, and nothing for none", () => {
    expect(serversFact([CORALOGIX, GRAFANA])).toBe('claude.ai Coralogix · grafana (query_logs)');
    expect(serversFact([{ name: 'grafana', tools: ['query_logs', 'get_panel'] }])).toBe(
      'grafana (query_logs, get_panel)',
    );
    expect(serversFact([])).toBeNull();
  });

  it("gives the node's third line, servers then skills (review S3)", () => {
    expect(nodeGrantsLine({ servers: [CORALOGIX, GRAFANA], skills: ['incident-triage'] })).toBe(
      'claude.ai Coralogix · grafana (query_logs) · skills: incident-triage',
    );
    expect(nodeGrantsLine({ servers: [CORALOGIX] })).toBe('claude.ai Coralogix');
    expect(nodeGrantsLine({ skills: ['incident-triage', 'release-notes'] })).toBe(
      'skills: incident-triage, release-notes',
    );
    expect(nodeGrantsLine({})).toBeNull();
    expect(nodeGrantsLine({ servers: [], skills: [] })).toBeNull();
  });

  it("is the spec's item line", () => {
    expect(ITEM_TEXT_LINE).toBe(
      'This agent reads text other people wrote, with these tools at hand.',
    );
  });
});

describe("an agent step's head and foot (review S2)", () => {
  it('says read-only, and "but for its servers" when its agent names any, narrowed or not', () => {
    expect(agentStepHead([])).toBe('Agent, read-only');
    expect(agentStepHead(undefined)).toBe('Agent, read-only');
    expect(agentStepHead([CORALOGIX])).toBe('Agent, read-only but for its servers');
    expect(agentStepHead([GRAFANA])).toBe('Agent, read-only but for its servers');
    expect(agentStepFoot([])).toBe('Read-only, in a session of its own');
    expect(agentStepFoot(undefined)).toBe('Read-only, in a session of its own');
    expect(agentStepFoot([GRAFANA])).toBe('Read-only but for its servers, in a session of its own');
  });
});
