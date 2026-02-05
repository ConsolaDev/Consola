// Session name generation using Claude Haiku
// Use require for dynamic loading to avoid bundling issues

export async function generateSessionName(query: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic();

    const response = await client.messages.create({
      model: 'claude-haiku-3-5-20241022',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Summarize this query into a short session title (3-5 words, no quotes, no punctuation at end):\n\n"${query.slice(0, 500)}"`
      }]
    });

    const textBlock = response.content.find((block: { type: string }) => block.type === 'text');
    const name = textBlock && 'text' in textBlock
      ? (textBlock as { text: string }).text.trim()
      : 'New Session';

    // Enforce max length and clean up
    return name.slice(0, 50).replace(/['".,;:!?]+$/, '');
  } catch (error) {
    console.error('Failed to generate session name:', error);
    return 'New Session';
  }
}
