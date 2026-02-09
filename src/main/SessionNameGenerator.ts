// Session name generation using Claude Agent SDK
// Uses dynamicImport pattern for ESM-only @anthropic-ai/claude-agent-sdk in CommonJS context

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<{ query: (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<SDKMessage> }>;

export async function generateSessionName(query: string): Promise<string> {
  try {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');

    const prompt = `Summarize this query into a short session title (3-5 words, no quotes, no punctuation at end):\n\n"${query.slice(0, 500)}"`;

    const response = sdk.query({
      prompt,
      options: {
        maxTurns: 1,
        allowedTools: [],
        abortController: new AbortController(),
      }
    });

    let result = '';

    for await (const message of response) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null && 'text' in block) {
              result += (block as { text: string }).text;
            }
          }
        } else if (typeof content === 'string') {
          result = content;
        }
      }
    }

    const name = result.trim();
    if (!name) return '';

    // Enforce max length and clean up
    return name.slice(0, 50).replace(/['".,;:!?]+$/, '');
  } catch (error) {
    console.error('Failed to generate session name:', error);
    return '';
  }
}
