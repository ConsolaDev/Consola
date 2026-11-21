import { describe, expect, it } from 'vitest';
import { harnessInitials, shortModelName } from './harnessMark';

describe('harnessInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(harnessInitials('Claude - Work')).toBe('CW');
    expect(harnessInitials('Claude Personal')).toBe('CP');
    expect(harnessInitials('claude-work')).toBe('CW');
    expect(harnessInitials('Claude · Work · Night shift')).toBe('CW');
  });

  it('is one letter for a one-word name', () => {
    expect(harnessInitials('Codex')).toBe('C');
    expect(harnessInitials('Claude')).toBe('C');
  });

  it('ignores punctuation and empty names', () => {
    expect(harnessInitials('  (Work)  ')).toBe('W');
    expect(harnessInitials('')).toBe('');
    expect(harnessInitials('—')).toBe('');
  });
});

describe('shortModelName', () => {
  it('names current Claude ids by family and version', () => {
    expect(shortModelName('claude-opus-4-6')).toBe('Opus 4.6');
    expect(shortModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(shortModelName('claude-opus-4-20250514')).toBe('Opus 4');
    expect(shortModelName('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('names legacy Claude ids the same way', () => {
    expect(shortModelName('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5');
    expect(shortModelName('claude-3-opus-20240229')).toBe('Opus 3');
  });

  it('keeps the long-context marker', () => {
    expect(shortModelName('claude-opus-4-6[1m]')).toBe('Opus 4.6 1M');
    expect(shortModelName('sonnet[1m]')).toBe('Sonnet 1M');
  });

  it('capitalises bare aliases', () => {
    expect(shortModelName('opus')).toBe('Opus');
    expect(shortModelName('haiku')).toBe('Haiku');
  });

  it('reads GPT ids as a version and its variants', () => {
    expect(shortModelName('gpt-5.1-codex')).toBe('GPT-5.1 Codex');
    expect(shortModelName('gpt-5.1-codex-max')).toBe('GPT-5.1 Codex Max');
    expect(shortModelName('gpt-5')).toBe('GPT-5');
    expect(shortModelName('gpt-oss-120b-medium')).toBe('GPT-OSS 120B');
  });

  it('reads Antigravity Gemini, Orchestrator and effort-suffixed Claude ids', () => {
    expect(shortModelName('gemini-4-neon-xhigh')).toBe('Gemini 4 Neon');
    expect(shortModelName('gemini-4-argon-medium')).toBe('Gemini 4 Argon');
    expect(shortModelName('gemini-4-hydrogen-low')).toBe('Gemini 4 Hydrogen');
    expect(shortModelName('gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash');
    expect(shortModelName('gemini-pro-orchestrator-neon')).toBe('Orchestrator (Neon)');
    expect(shortModelName('gemini-pro-orchestrator-g1-pro')).toBe('Orchestrator (Argon)');
    expect(shortModelName('claude-opus-5-5-high')).toBe('Opus 5.5');
    expect(shortModelName('claude-sonnet-5-5-medium')).toBe('Sonnet 5.5');
  });

  it('leaves anything else whole', () => {
    expect(shortModelName('o3')).toBe('o3');
    expect(shortModelName('my-local-model')).toBe('my-local-model');
  });
});
