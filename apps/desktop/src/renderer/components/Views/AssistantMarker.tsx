/**
 * Says a session is one the Assistant started or last prompted.
 *
 * Shares the checkout chip's frame so the two read as one family of header
 * facts, but it is not interactive: there is nothing to copy or open.
 */
export function AssistantMarker() {
  return (
    <span className="checkout-chip assistant-marker" title="Started or last prompted by the Assistant">
      <span className="assistant-marker-label">✦ Assistant</span>
    </span>
  );
}
