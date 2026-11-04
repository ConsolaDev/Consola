/**
 * The uniform MCP tool envelope: single-line JSON on success — the bell, not
 * the package — and the bare message on failure.
 */
export async function asToolResult(run: () => unknown | Promise<unknown>) {
    try {
        const value = await run();
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    } catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: 'text' as const,
                    text: error instanceof Error ? error.message : String(error),
                },
            ],
        };
    }
}
